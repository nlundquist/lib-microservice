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
const base64url = require("base64url");
const EventEmitter = require("events");
const jwt = require("jsonwebtoken");
const { NATSClient } = require("@randomrod/lib-nats-client");
const CLIENT_PREFIX = 'CLIENT';
class Microservice extends NATSClient {
    constructor(serviceName) {
        super(serviceName);
        this.serviceName = serviceName;
        this.messageValidator = {
            privateKey: process.env.JWT_PRIVATE_KEY || null,
            publicKey: process.env.JWT_PUBLIC_KEY || null,
            algorithm: process.env.JWT_ALGORITHM || null
        };
        this.seedServers = process.env.SEED_SERVERS || 'az1.nats.mesh,az2.nats.mesh,az3.nats.mesh';
    }
    init() {
        const _super = Object.create(null, {
            init: { get: () => super.init }
        });
        return __awaiter(this, void 0, void 0, function* () {
            //Randomize the NATSClient Connections to the Mesh
            let serverList = this.seedServers.split(',');
            this.natsServer = serverList[Math.round(Math.random() * (serverList.length - 1))];
            yield _super.init.call(this);
            if (!this.messageValidator.privateKey) {
                try {
                    this.emit('debug', 'no correlation', 'Message Signing NOT Configured');
                }
                catch (err) { }
            }
            if (!this.messageValidator.publicKey) {
                try {
                    this.emit('debug', 'no correlation', 'Message Validation NOT Configured');
                }
                catch (err) { }
            }
        });
    }
    queryTopic(topic, context, payload, timeoutOverride, topicPrefixOverride) {
        const _super = Object.create(null, {
            queryTopic: { get: () => super.queryTopic }
        });
        return __awaiter(this, void 0, void 0, function* () {
            if (typeof context !== 'object' || typeof payload !== 'object')
                throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
            //Reset the Context to remove previously decoded information (keep it clean!)
            let newContext = {
                correlationUUID: context.correlationUUID ? context.correlationUUID : 'MICROSERVICE'
            };
            if (context.idToken)
                newContext.idToken = context.idToken;
            if (context.serviceToken)
                newContext.serviceToken = context.serviceToken;
            if (context.impersonationToken)
                newContext.impersonationToken = context.impersonationToken;
            if (context.ephemeralToken)
                newContext.ephemeralToken = context.ephemeralToken;
            let queryData = {
                context: newContext,
                payload
            };
            let stringQueryData = JSON.stringify(queryData);
            try {
                this.emit('debug', newContext.correlationUUID, `NATS REQUEST (${topic}): ${stringQueryData}`);
            }
            catch (err) { }
            let queryResponse = null;
            if (timeoutOverride)
                queryResponse = yield _super.queryTopic.call(this, `${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringQueryData, timeoutOverride);
            else
                queryResponse = yield _super.queryTopic.call(this, `${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringQueryData);
            if (!queryResponse)
                throw 'INVALID RESPONSE from NATS Mesh';
            try {
                this.emit('debug', newContext.correlationUUID, `NATS RESPONSE (${topic}): ${queryResponse}`);
            }
            catch (err) { }
            let parsedResponse = JSON.parse(queryResponse);
            if (parsedResponse.response.errors)
                throw parsedResponse.response.errors;
            return parsedResponse.response.result;
        });
    }
    publishEvent(topic, context, payload, topicPrefixOverride) {
        if (typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
        let eventData = {
            context,
            payload
        };
        let stringEventData = JSON.stringify(eventData);
        try {
            this.emit('debug', 'no correlation', `NATS PUBLISH: ${stringEventData}`);
        }
        catch (err) { }
        return super.publishTopic(`${topicPrefixOverride ? topicPrefixOverride : CLIENT_PREFIX}.${topic}`, stringEventData);
    }
    registerTopicHandler(topic, fnHandler, queue = null, topicPrefixOverride) {
        try {
            let topicHandler = (request, replyTo, topic) => __awaiter(this, void 0, void 0, function* () {
                let errors = null;
                let result = null;
                try {
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);
                    }
                    catch (err) { }
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if (!parsedRequest.context || !parsedRequest.payload)
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';
                    //Verify MESSAGE AUTHORIZATION
                    parsedRequest.context.assertions = this.validateRequest(topic, parsedRequest.context);
                    parsedRequest.context.topic = topic.substring(topic.indexOf(".") + 1);
                    //Request is Valid, Handle the Request
                    result = yield fnHandler(parsedRequest);
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
                    let error = `Service Error(${fnHandler.name.substring(6)}): ${JSON.stringify(err)}`;
                    try {
                        this.emit('error', 'SERVICE', error);
                    }
                    catch (err) { }
                    if (!errors)
                        errors = [err];
                }
                if (replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + JSON.stringify(errors ? errors : result));
                    }
                    catch (err) { }
                }
                else {
                    try {
                        this.emit('info', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');
                    }
                    catch (err) { }
                }
            });
            super.registerTopicHandler(`${topicPrefixOverride ? topicPrefixOverride : 'MESH'}.${topic}`, topicHandler, queue);
        }
        catch (err) {
            try {
                this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler Error: ' + err);
            }
            catch (err) { }
        }
    }
    generateToken(assertions) {
        try {
            if (!this.messageValidator.privateKey || !this.messageValidator.algorithm)
                throw "MessageValidator Not Configured";
            return jwt.sign(assertions, this.messageValidator.privateKey, { algorithm: this.messageValidator.algorithm });
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Generating Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
    }
    verifyToken(token) {
        try {
            if (!this.messageValidator.publicKey || !this.messageValidator.algorithm)
                throw "MessageValidator Not Configured";
            return jwt.verify(token, this.messageValidator.publicKey, { algorithms: [this.messageValidator.algorithm] });
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Verifying Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
    }
    decodeToken(token) {
        try {
            let decoded = jwt.decode(token, { complete: true });
            return decoded.payload;
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Decoding Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
    }
    //PRIVATE FUNCTIONS
    validateRequest(topic, context) {
        if (!context.ephemeralToken && !topic.endsWith("NOAUTH")) // && !topic.endsWith("INTERNAL"))
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';
        if (!context.ephemeralToken)
            return {};
        let token_assertions = null;
        try {
            token_assertions = (this.messageValidator.publicKey && this.messageValidator.algorithm)
                ? this.verifyToken(context.ephemeralToken)
                : this.decodeToken(context.ephemeralToken);
            if (!token_assertions)
                throw "Error Decoding Ephemeral Authorization Token";
            if (token_assertions.exp < Date.now())
                throw "Ephemeral Authorization Token Expired";
            if (!token_assertions.ephemeralAuth)
                throw "Invalid Ephemeral Authorization Token";
            let ephemeralAuth = JSON.parse(base64url.decode(token_assertions.ephemeralAuth));
            if (!ephemeralAuth.authentication || !ephemeralAuth.authorization)
                throw "Invalid Ephemeral Authorization Token Payload";
            token_assertions.authentication = ephemeralAuth.authentication;
            token_assertions.authorization = ephemeralAuth.authorization;
        }
        catch (err) {
            throw `UNAUTHORIZED: validateRequest Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }
    publishResponse(replyTopic, errors, result) {
        let response = JSON.stringify({
            response: {
                errors: errors,
                result: result
            }
        });
        return super.publishTopic(replyTopic, response);
    }
}
exports.Microservice = Microservice;
