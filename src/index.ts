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
    }

    async queryTopic(topic: string, context: any, payload: any, timeoutOverride?: number, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        //Reset the Context to remove previously decoded information (keep it clean!)
        let newContext = {
            idToken:            context.idToken             ? context.idToken               : null,
            serviceToken:       context.serviceToken        ? context.serviceToken          : null,
            impersonationToken: context.impersonationToken  ? context.impersonationToken    : null,
            ephemeralToken:     context.ephemeralToken      ? context.ephemeralToken        : null,
        }
        let queryData = {
            context: newContext,
            payload
        };

        //TODO ROD HERE - JSON SUPPORT?
        if(timeoutOverride) return super.queryTopic(topic, JSON.stringify(queryData), timeoutOverride);
        return await super.queryTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, JSON.stringify(queryData));
    }

    publishEvent(topic: string, context: any, payload: any, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let eventData = {
            context,
            payload
        };

        //TODO ROD HERE - JSON SUPPORT?
        return super.publishTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, JSON.stringify(eventData));
    }

    registerTopicHandler(topic: string, fnHandler: any, queue: any = null, topicPrefixOverride?: string) {
        try {
            let topicHandler = async (request: string, replyTo: string, topic: string) => {
                let errors = null;
                let result = null;

                try {
                    this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);

                    //TODO ROD HERE - JSON SUPPORT?
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest.request || !parsedRequest.request.context || !parsedRequest.request.payload )
                        throw 'INVALID REQUEST: One or more of request, context, or payload are missing.';

                    //Verify MESSAGE AUTHORIZATION
                    parsedRequest.request.context.assertions = this.validateRequest(topic, parsedRequest.request.context);
                    parsedRequest.request.context.topic = topic.substring(topic.indexOf(".")+1);

                    //Request is Valid, Handle the Request
                    result = await fnHandler(parsedRequest.request);
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
                    let error = `Service Error(${fnHandler.name}): ${JSON.stringify(err)}`;
                    this.emit('error', 'SERVICE', error);
                    if(!errors) errors = [err];
                }

                if(replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + JSON.stringify(result));
                } else {
                    this.emit('info', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');
                }
            };

            super.registerTopicHandler(`${topicPrefixOverride ? topicPrefixOverride : 'MESH'}.${topic}`, topicHandler, queue);

        } catch(err) {
            this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler Error: ' + err);
        }
    }

    generateToken(assertions: any) {
        if(!this.messageValidator.privateKey || !this.messageValidator.algorithm) throw "MessageValidator Not Configured";
        return jwt.sign(assertions, this.messageValidator.privateKey, {algorithms: [this.messageValidator.algorithm]});
    }

    verifyToken(token: any) {
        if(!this.messageValidator.publicKey || !this.messageValidator.algorithm) throw "MessageValidator Not Configured";
        return jwt.verify(token, this.messageValidator.publicKey, {algorithms: [this.messageValidator.algorithm]});
    }

    decodeToken(token: any) {
        return jwt.decode(token);
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

            if(!token_assertions.ephemeralAuth || !token_assertions.authCache) throw "Invalid Ephemeral Authorization Token";
            let ephemeralAuth = JSON.parse(base64url.decode(token_assertions.ephemeralAuth));

            if(!ephemeralAuth.authentication || !ephemeralAuth.authorization) throw "Invalid Ephemeral Authorization Token Payload";
            token_assertions.authentication = ephemeralAuth.authentication;
            token_assertions.authorization = ephemeralAuth.authorization;

        } catch(err) {
            throw `UNAUTHORIZED: JWT Verify Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }

    private publishResponse(replyTopic: string, errors: any, result: any) {
        //TODO ROD HERE - JSON SUPPORT?
        let response = JSON.stringify({
            response: {
                errors: errors,
                result: result
            }
        });
        return super.publishTopic(replyTopic, response);
    }

}