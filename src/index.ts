"use strict";
const base64url         = require("base64url");
const EventEmitter      = require("events");
const jwt               = require("jsonwebtoken");
const { NATSClient }    = require("@randomrod/lib-nats-client");

const CLIENT_PREFIX = 'CLIENT';

export class Microservice extends NATSClient {
    messageValidator: any = {
        privateKey: process.env.JWT_PRIVATE_KEY || null,
        publicKey:  process.env.JWT_PUBLIC_KEY  || null,
        algorithm:  process.env.JWT_ALGORITHM   || null
    };

    constructor(public serviceName: string) {
        super(serviceName);
    }

    async init() {
        await super.init();
        if(!this.messageValidator.privateKey) {
            try{this.emit('info', 'no correlation', 'Message Signing NOT Configured');}catch(err){}
        }
        if(!this.messageValidator.publicKey) {
            try{this.emit('info', 'no correlation', 'Message Validation NOT Configured');}catch(err){}
        }
    }

    async queryTopic(topic: string, context: any, payload: any, timeoutOverride?: number, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        //Reset the Context to remove previously decoded information (keep it clean!)
        let newContext: any = {
            correlationUUID: context.correlationUUID ? context.correlationUUID : 'MICROSERVICE'
        };
        if(context.idToken) newContext.idToken = context.idToken;
        if(context.serviceToken) newContext.serviceToken = context.serviceToken;
        if(context.impersonationToken) newContext.impersonationToken = context.impersonationToken;
        if(context.ephemeralToken) newContext.ephemeralToken = context.ephemeralToken;

        let queryData = {
            context: newContext,
            payload
        };

        let stringQueryData = JSON.stringify(queryData);
        try{this.emit('debug', newContext.correlationUUID, `NATS REQUEST (${topic}): ${stringQueryData}`);}catch(err){}

        let queryResponse = null;
        if(timeoutOverride) queryResponse = await super.queryTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringQueryData, timeoutOverride);
        else queryResponse = await super.queryTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringQueryData);

        if(!queryResponse) throw 'INVALID RESPONSE from NATS Mesh';

        try{this.emit('debug', newContext.correlationUUID, `NATS RESPONSE (${topic}): ${queryResponse}`);}catch(err){}
        let parsedResponse = JSON.parse(queryResponse);

        if(parsedResponse.response.errors) throw parsedResponse.response.errors;
        return parsedResponse.response.result;
    }

    publishEvent(topic: string, context: any, payload: any, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let eventData = {
            context,
            payload
        };

        let stringEventData = JSON.stringify(eventData);
        try{this.emit('debug', 'no correlation', `NATS PUBLISH: ${stringEventData}`);}catch(err){}

        return super.publishTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringEventData);
    }

    registerTopicHandler(topic: string, fnHandler: any, queue: any = null, topicPrefixOverride?: string) {
        try {
            let topicHandler = async (request: string, replyTo: string, topic: string) => {
                let errors = null;
                let result = null;

                try {
                    try{this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);}catch(err){}

                    let parsedRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest.context || !parsedRequest.payload )
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';

                    //Verify MESSAGE AUTHORIZATION
                    parsedRequest.context.assertions = this.validateRequest(topic, parsedRequest.context);
                    parsedRequest.context.topic = topic.substring(topic.indexOf(".")+1);

                    //Request is Valid, Handle the Request
                    result = await fnHandler(parsedRequest);
                    if(typeof result !== 'object') {
                        result = {
                            status: result
                        };
                    } else if (result === {}) {
                        result = {
                            status: "SUCCESS"
                        }
                    }

                } catch(err) {
                    let error = `Service Error(${fnHandler.name.substring(6)}): ${JSON.stringify(err)}`;
                    try{this.emit('error', 'SERVICE', error);}catch(err){}
                    if(!errors) errors = [err];
                }

                if(replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + JSON.stringify(errors ? errors : result));}catch(err){}
                } else {
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');}catch(err){}
                }
            };

            super.registerTopicHandler(`${topicPrefixOverride ? topicPrefixOverride : 'MESH'}.${topic}`, topicHandler, queue);

        } catch(err) {
            try{this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler Error: ' + err);}catch(err){}
        }
    }

    generateToken(assertions: any) {
        try {
            if(!this.messageValidator.privateKey || !this.messageValidator.algorithm) throw "MessageValidator Not Configured";
            return jwt.sign(assertions, this.messageValidator.privateKey, {algorithm: this.messageValidator.algorithm});
        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Generating Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
    }

    verifyToken(token: any) {
        try {
            if(!this.messageValidator.publicKey || !this.messageValidator.algorithm) throw "MessageValidator Not Configured";
            return jwt.verify(token, this.messageValidator.publicKey, {algorithms: [this.messageValidator.algorithm]});
        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Verifying Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
    }

    decodeToken(token: any) {
        try {
            let decoded: any = jwt.decode(token, {complete: true});
            return decoded.payload;
        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Decoding Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
    }

    //PRIVATE FUNCTIONS
    private validateRequest(topic: string, context: any) {

        if(!context.ephemeralToken && !topic.endsWith("NOAUTH"))// && !topic.endsWith("INTERNAL"))
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';

        if(!context.ephemeralToken) return {};

        let token_assertions = null;
        try {
            token_assertions = (this.messageValidator.publicKey && this.messageValidator.algorithm)
                ? this.verifyToken(context.ephemeralToken)
                : this.decodeToken(context.ephemeralToken);

            if(!token_assertions)                 throw "Error Decoding Ephemeral Authorization Token";
            if(token_assertions.exp < Date.now()) throw "Ephemeral Authorization Token Expired";

            if(!token_assertions.ephemeralAuth) throw "Invalid Ephemeral Authorization Token";
            let ephemeralAuth = JSON.parse(base64url.decode(token_assertions.ephemeralAuth));

            if(!ephemeralAuth.authentication || !ephemeralAuth.authorization) throw "Invalid Ephemeral Authorization Token Payload";
            if(!ephemeralAuth.authorization.superAdmin && topic.endsWith("RESTRICTED")) throw "SCOPE VIOLATION: Requires SuperAdmin Access";

            token_assertions.authentication = ephemeralAuth.authentication;
            token_assertions.authorization = ephemeralAuth.authorization;

        } catch(err) {
            throw `UNAUTHORIZED: validateRequest Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }

    private publishResponse(replyTopic: string, errors: any, result: any) {
        let response = JSON.stringify({
            response: {
                errors: errors,
                result: result
            }
        });
        return super.publishTopic(replyTopic, response);
    }

}