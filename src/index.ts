"use strict";

const EventEmitter      = require("events");
const jwt               = require("jsonwebtoken");
const { NATSClient }    = require("@randomrod/lib-nats-client");

export default class Microservice extends NATSClient {
    messageValidator: any = {
        publicKey: process.env.JWT_PUBLIC_KEY || null,
        algorithm: process.env.JWT_ALGORITHM  || null
    };

    constructor(public serviceName: string) {
        super(serviceName);
    }

    async init() {
        await super.init();
    }

    authorizeRequest(topic: string, context: any) {
        if(!this.messageValidator.publicKey || !this.messageValidator.algorithm)
            throw 'UNAUTHORIZED:  Validator Not Configured';

        if(!context.ephemeralToken && !topic.endsWith("NOAUTH"))
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';

        if(!context.ephemeralToken) return {};

        let user_assertions = null;
        try {
            user_assertions = jwt.verify(context.ephemeralToken, this.messageValidator.publicKey, {algorithms: [this.messageValidator.algorithm]});
        } catch(err) {
            throw `UNAUTHORIZED: JWT Verify Error: ${JSON.stringify(err)}`;
        }
        if(!user_assertions)                    throw "UNAUTHORIZED: Invalid Ephemeral Authorization Token";
        if(user_assertions.exp < Date.now())    throw "UNAUTHORIZED: Ephemeral Authorization Token Expired";
        return user_assertions;
    }

    async queryTopic(topic: string, context: any, payload: any, timeoutOverride?: number, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let queryData = {
            context,
            payload
        };

        //TODO ROD HERE - JSON SUPPORT?
        if(timeoutOverride) return super.queryTopic(topic, JSON.stringify(queryData), timeoutOverride);
        return await super.queryTopic(`${topicPrefixOverride ? topicPrefixOverride : 'CLIENT'}.${topic}`, JSON.stringify(queryData));
    }

    publishEvent(topic: string, context: any, payload: any, topicPrefixOverride?: string) {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let eventData = {
            context,
            payload
        };

        //TODO ROD HERE - JSON SUPPORT?
        return super.publishTopic(`${topicPrefixOverride ? topicPrefixOverride : 'CLIENT'}.${topic}`, JSON.stringify(eventData));
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
                    parsedRequest.request.context.assertions = this.authorizeRequest(topic, parsedRequest.request.context);

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

}