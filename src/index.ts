"use strict";
const base64url         = require("base64url");
const EventEmitter      = require("events");
const jwt               = require("jsonwebtoken");
const { NATSClient }    = require("@randomrod/lib-nats-client");
const uuid              = require("uuid");

const CLIENT_PREFIX = 'CLIENT';
const MESH_PREFIX   = 'MESH';

const SUPERADMIN    = 'SUPERADMIN';
const QUERY_TIMEOUT = 7500;

export class Microservice extends NATSClient {
    sourceVersion: string = process.env.SOURCE_VERSION || 'LOCAL';

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
        this.registerTestHandler();
    }

    async queryTopic(topic: string, context: any, payload: any, queryTimeout: number = QUERY_TIMEOUT, topicPrefix: string = CLIENT_PREFIX) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        //Reset the Context to remove previously decoded information (keep it clean!)
        let newContext: any = {
            correlationUUID:    context.correlationUUID     || 'MICROSERVICE',
            idToken:            context.idToken             || null,
            serviceToken:       context.serviceToken        || null,
            impersonationToken: context.impersonationToken  || null,
            ephemeralToken:     context.ephemeralToken      || null,
        };

        let queryData = JSON.stringify({ context: newContext, payload });
        try{this.emit('debug', newContext.correlationUUID, `NATS REQUEST (${topic}): ${queryData}`);}catch(err){}

        let queryResponse = await super.queryTopic(`${topicPrefix}.${topic}`, queryData, queryTimeout);
        if(!queryResponse) throw `INVALID RESPONSE (${topic}) from NATS Mesh`;

        try{this.emit('debug', newContext.correlationUUID, `NATS RESPONSE (${topic}): ${queryResponse}`);}catch(err){}
        let parsedResponse = JSON.parse(queryResponse);

        if(parsedResponse.response.errors) throw parsedResponse.response.errors;
        return parsedResponse.response.result;
    }

    publishEvent(topic: string, context: any, payload: any, topicPrefix: string = CLIENT_PREFIX) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let eventData = JSON.stringify({ context, payload });
        try{this.emit('debug', 'no correlation', `NATS PUBLISH (${topic}): ${eventData}`);}catch(err){}

        return super.publishTopic(`${topicPrefix}.${topic}`, eventData);
    }

    registerTopicHandler(topic: string, fnHandler: any, minScopeRequired: string = SUPERADMIN, queue: string | null = null, topicPrefix: string = MESH_PREFIX) {
        try {
            let topicHandler = async (request: string, replyTo: string, topic: string) => {
                let errors = null;
                let result = null;
                let topicStart = Date.now();

                try {
                    try{this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);}catch(err){}

                    let parsedRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest.context || !parsedRequest.payload )
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';

                    //Verify MESSAGE AUTHORIZATION
                    parsedRequest.context.assertions = this.validateRequest(topic, parsedRequest.context, minScopeRequired);
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

                let topicDuration = Date.now() - topicStart;

                if(replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | ' + JSON.stringify(errors ? errors : result));}catch(err){}
                } else {
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | No Response Requested');}catch(err){}
                }
            };

            super.registerTopicHandler(`${topicPrefix}.${topic}`, topicHandler, queue);

        } catch(err) {
            try{this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler (' + topic + ') Error: ' + err);}catch(err){}
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
    private validateRequest(topic: string, context: any, minScopeRequired: string) {

        if(!context.ephemeralToken && !topic.endsWith("NOAUTH"))// && !topic.endsWith("INTERNAL"))
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';

        if(!context.ephemeralToken) return {};

        let token_assertions: any = null;
        try {
            token_assertions = (this.messageValidator.publicKey && this.messageValidator.algorithm)
                ? this.verifyToken(context.ephemeralToken)
                : this.decodeToken(context.ephemeralToken);

            if(!token_assertions)                 throw "Error Decoding Ephemeral Authorization Token";
            if(token_assertions.exp < Date.now()) throw "Ephemeral Authorization Token Expired";

            if(!token_assertions.ephemeralAuth) throw "Invalid Ephemeral Authorization Token";
            let ephemeralAuth = JSON.parse(base64url.decode(token_assertions.ephemeralAuth));

            if(!ephemeralAuth.authentication || !ephemeralAuth.authorization) throw "Invalid Ephemeral Authorization Token Payload";

            token_assertions.authentication = ephemeralAuth.authentication;
            token_assertions.authorization = ephemeralAuth.authorization;
            token_assertions.scopeRestriction = this.authorizeScope(token_assertions, minScopeRequired, topic);
            token_assertions.scope = (topic: string) => {
                if(token_assertions.authorization.superAdmin) return '*';
                return token_assertions.authorization.permissions[topic] || 'NONE';
            };

        } catch(err) {
            throw `UNAUTHORIZED: validateRequest Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }

    private authorizeScope(assertions: any, minScopeRequired: string, topic: string) {
        if(topic.endsWith("RESTRICTED") && !assertions.authorization.superAdmin)
            throw 'UNAUTHORIZED:  Requires SUPERADMIN Privileges';

        switch(minScopeRequired) {
            case 'SUPERADMIN':
                if(!assertions.authorization.superAdmin)  throw 'UNAUTHORIZED:  Requires SUPERADMIN Privileges';
                break;
            case '*':
                if(assertions.authorization.scope !== '*')  throw 'UNAUTHORIZED:  Requires GLOBAL Permission Scope';
                break;

            case 'SITE':
                if( assertions.authorization.scope !== '*' &&
                    assertions.authorization.scope !== 'SITE')  throw 'UNAUTHORIZED:  Requires SITE Permission Scope or Greater';
                break;

            case 'MEMBER':
                if( assertions.authorization.scope !== '*' &&
                    assertions.authorization.scope !== 'SITE' &&
                    assertions.authorization.scope !== 'MEMBER')  throw 'UNAUTHORIZED:  Requires MEMBER Permission Scope or Greater';
                break;

            case 'OWNER':
                if( assertions.authorization.scope !== '*' &&
                    assertions.authorization.scope !== 'SITE' &&
                    assertions.authorization.scope !== 'MEMBER' &&
                    assertions.authorization.scope !== 'OWNER')  throw 'UNAUTHORIZED:  Requires OWNER Permission Scope or Greater';
                break;

            default:
                throw 'SERVER ERROR:  Invalid Scope Requirement';
        }

        let scopeRestriction: any = null;
        switch(assertions.authorization.scope) {
            case "SITE":
                scopeRestriction = { site_id: assertions.authentication.site_id };
                break;

            case "MEMBER":
                scopeRestriction = { member_id: assertions.authentication.member_id };
                break;

            case "OWNER":
                scopeRestriction = { user_id: assertions.authentication.user_id };
        }
        return scopeRestriction;
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

    //***************************************************
    // TOPOLOGY TEST Functions
    //***************************************************
    async scanToplogy(request: any) {
        if(!request.payload.testID) throw 'No Test ID specified';
        if(!request.payload.nodes)  throw 'No Test Nodes specified';

        let scanResult: any = {
            testStart: Date.now(),
        };

        let nodeResults: any[] = [];
        let testRequest = JSON.stringify({ context: request.context, payload: { testID: request.payload.testID }});
        for(let node of request.payload.nodes) {

            let nodeStart = Date.now();
            let nodeResult: any = { node };
            let queryResponse = await super.queryTopic(`TEST.${node}.ping.validate`, testRequest, 100);

            nodeResult.duration = Date.now() - nodeStart;
            if(!queryResponse) {
                nodeResult.result = `NO RESPONSE`;
            } else {
                let parsedResponse = JSON.parse(queryResponse);
                if(parsedResponse.response.errors) {
                    let errorString = JSON.stringify(parsedResponse.response.errors);
                    if(errorString.indexOf('TIMEOUT') >= 0)
                        nodeResult.result = 'TIMEOUT';
                    else
                        nodeResult.result = `${errorString}`;
                } else if(!parsedResponse.response.result) {
                    nodeResult.result = 'NO RESULT';
                } else {
                    if(parsedResponse.response.result.testID = request.payload.testID)
                        nodeResult.result = 'OK';
                    else
                        nodeResult.result = 'UNCORRELATED';
                }
            }
            nodeResults.push(nodeResult);
        }

        scanResult.testEnd = Date.now();
        scanResult.duration = scanResult.testEnd - scanResult.testStart;
        scanResult.nodeResults = nodeResults;
        return scanResult;
    }

    async versionNode(request: any) {
        return { version: this.sourceVersion };
    }

    private registerTestHandler() {
        let instanceID = uuid.v4();
        let testTopic = `TEST.${this.serviceName}.${instanceID}`;

        try {
            let topicHandler = async (request: string, replyTo: string, topic: string) => {
                let errors = null;
                let result = null;

                try {
                    try{this.emit('debug', 'SERVICE TEST', 'Microservice | TopicHandler (' + topic + ') | ' + request);}catch(err){}

                    let parsedRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest) throw 'INVALID REQUEST: Either context or payload, or both, are missing.';

                    result = await this.versionNode(parsedRequest);

                } catch(err) {
                    let error = `Test Error(${topic}): ${JSON.stringify(err)}`;
                    try{this.emit('error', 'SERVICE TEST', error);}catch(err){}
                    if(!errors) errors = [err];
                }

                if(replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + JSON.stringify(errors ? errors : result));}catch(err){}
                } else {
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');}catch(err){}
                }
            };

            super.registerTopicHandler(testTopic, topicHandler, instanceID);

        } catch(err) {
            try{this.emit('error', 'SERVICE TEST', 'Microservice | registerTopicHandler (' + testTopic + ') Error: ' + err);}catch(err){}
        }
    }

}