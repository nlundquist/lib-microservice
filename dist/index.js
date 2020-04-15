"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const EventEmitter = require("events");
const jwt = require("jsonwebtoken");
const { NATSClient } = require("@randomrod/lib-nats-client");
class Microservice extends NATSClient {
    constructor(serviceName) {
        super(serviceName);
        this.serviceName = serviceName;
        this.messageValidator = {
            publicKey: process.env.JWT_PUBLIC_KEY || null,
            algorithm: process.env.JWT_ALGORITHM || null
        };
    }
    init() {
        const _super = Object.create(null, {
            init: { get: () => super.init }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.init.call(this);
        });
    }
    authorizeRequest(topic, context) {
        if (!this.messageValidator.publicKey || !this.messageValidator.algorithm)
            throw 'UNAUTHORIZED:  Validator Not Configured';
        if (!context.ephemeralToken && !topic.endsWith("NOAUTH"))
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';
        if (!context.ephemeralToken)
            return {};
        let user_assertions = null;
        try {
            user_assertions = jwt.verify(context.ephemeralToken, this.messageValidator.publicKey, { algorithms: [this.messageValidator.algorithm] });
        }
        catch (err) {
            throw `UNAUTHORIZED: JWT Verify Error: ${JSON.stringify(err)}`;
        }
        if (!user_assertions)
            throw "UNAUTHORIZED: Invalid Ephemeral Authorization Token";
        if (user_assertions.exp < Date.now())
            throw "UNAUTHORIZED: Ephemeral Authorization Token Expired";
        return user_assertions;
    }
    queryTopic(topic, context, payload, timeoutOverride, topicPrefixOverride) {
        const _super = Object.create(null, {
            queryTopic: { get: () => super.queryTopic }
        });
        return __awaiter(this, void 0, void 0, function* () {
            if (typeof context !== 'object' || typeof payload !== 'object')
                throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
            let queryData = {
                context,
                payload
            };
            //TODO ROD HERE - JSON SUPPORT?
            if (timeoutOverride)
                return _super.queryTopic.call(this, topic, JSON.stringify(queryData), timeoutOverride);
            return yield _super.queryTopic.call(this, `${topicPrefixOverride ? topicPrefixOverride : 'CLIENT'}.${topic}`, JSON.stringify(queryData));
        });
    }
    publishEvent(topic, context, payload, topicPrefixOverride) {
        if (typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
        let eventData = {
            context,
            payload
        };
        //TODO ROD HERE - JSON SUPPORT?
        return super.publishTopic(`${topicPrefixOverride ? topicPrefixOverride : 'CLIENT'}.${topic}`, JSON.stringify(eventData));
    }
    publishResponse(replyTopic, errors, result) {
        //TODO ROD HERE - JSON SUPPORT?
        let response = JSON.stringify({
            response: {
                errors: errors,
                result: result
            }
        });
        return super.publishTopic(replyTopic, response);
    }
    registerTopicHandler(topic, fnHandler, queue = null, topicPrefixOverride) {
        try {
            let topicHandler = (request, replyTo, topic) => __awaiter(this, void 0, void 0, function* () {
                let errors = null;
                let result = null;
                try {
                    this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);
                    //TODO ROD HERE - JSON SUPPORT?
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if (!parsedRequest.request || !parsedRequest.request.context || !parsedRequest.request.payload)
                        throw 'INVALID REQUEST: One or more of request, context, or payload are missing.';
                    //Verify MESSAGE AUTHORIZATION
                    parsedRequest.request.context.assertions = this.authorizeRequest(topic, parsedRequest.request.context);
                    //Request is Valid, Handle the Request
                    result = yield fnHandler(parsedRequest.request);
                    if (typeof result !== 'object') {
                        result = {
                            status: result
                        };
                    }
                    else if (result === {}) {
                        result = {
                            status: "SUCCESS"
                        };
                    }
                }
                catch (err) {
                    let error = `Service Error(${fnHandler.name}): ${JSON.stringify(err)}`;
                    this.emit('error', 'SERVICE', error);
                    if (!errors)
                        errors = [err];
                }
                if (replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + JSON.stringify(result));
                }
                else {
                    this.emit('info', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');
                }
            });
            super.registerTopicHandler(`${topicPrefixOverride ? topicPrefixOverride : 'MESH'}.${topic}`, topicHandler, queue);
        }
        catch (err) {
            this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler Error: ' + err);
        }
    }
}
exports.default = Microservice;
