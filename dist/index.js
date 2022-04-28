import { NATSClient } from '@randomrod/lib-nats-client';
import base64url from 'base64url';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
const DOMAIN_INTERNAL = 'INTERNAL';
const INTERNAL_PREFIX = 'INTERNAL';
const MESH_PREFIX = 'MESH';
const SUPERADMIN = 'SUPERADMIN';
const QUERY_TIMEOUT = 7500;
export class Microservice extends NATSClient {
    constructor(serviceName) {
        super(serviceName);
        this.sourceVersion = process.env.SOURCE_VERSION || 'LOCAL';
        this.messageValidator = {
            privateKey: process.env.JWT_PRIVATE_KEY || null,
            publicKey: process.env.JWT_PUBLIC_KEY || null,
            jwtAlgorithm: (process.env.JWT_ALGORITHM || 'RS256'),
        };
        this.serviceMessages = [];
    }
    async init() {
        await super.init();
        if (!this.messageValidator.privateKey)
            try {
                this.emit('info', 'no correlation', 'Message Signing NOT Configured');
            }
            catch (err) { }
        if (!this.messageValidator.publicKey)
            try {
                this.emit('info', 'no correlation', 'Message Validation NOT Configured');
            }
            catch (err) { }
        this.registerTestHandler();
    }
    async query(topic, context, payload, queryTimeout = QUERY_TIMEOUT, topicPrefix = INTERNAL_PREFIX) {
        if (typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
        let newContext = {
            correlationUUID: context.correlationUUID || uuidv4(),
            siteID: context.siteID || null,
            idToken: context.idToken || null,
            ephemeralToken: context.ephemeralToken || null,
            proxyToken: context.proxyToken || null,
        };
        let queryData = JSON.stringify({ context: newContext, payload });
        try {
            this.emit('debug', newContext.correlationUUID, `NATS REQUEST (${topic}): ${queryData}`);
        }
        catch (err) { }
        let topicStart = Date.now();
        let queryResponse = await super.queryTopic(`${topicPrefix}.${topic}`, queryData, queryTimeout);
        if (!queryResponse)
            throw `INVALID RESPONSE (${topic}) from NATS Mesh`;
        let topicDuration = Date.now() - topicStart;
        try {
            this.emit('info', newContext.correlationUUID, `NATS RESPONSE (${topic}) | ${topicDuration} ms`);
        }
        catch (err) { }
        try {
            this.emit('debug', newContext.correlationUUID, `NATS RESPONSE (${topic}) | ${topicDuration} ms : ${queryResponse}`);
        }
        catch (err) { }
        let parsedResponse = JSON.parse(queryResponse);
        if (parsedResponse.response.errors)
            throw parsedResponse.response.errors;
        return parsedResponse.response.result;
    }
    publish(topic, context, payload, topicPrefix = INTERNAL_PREFIX) {
        if (typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';
        let eventData = JSON.stringify({ context, payload });
        try {
            this.emit('debug', 'no correlation', `NATS PUBLISH (${topic}): ${eventData}`);
        }
        catch (err) { }
        return super.publishTopic(`${topicPrefix}.${topic}`, eventData);
    }
    registerHandler(handlerTopic, fnHandler, minScopeRequired = SUPERADMIN, queue = null, topicPrefix = MESH_PREFIX) {
        try {
            this.serviceMessages.push(handlerTopic);
            let topicHandler = async (request, replyTo, topic) => {
                let errors = null;
                let result = null;
                let topicStart = Date.now();
                topic = topic.substring(topic.indexOf(".") + 1);
                try {
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);
                    }
                    catch (err) { }
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if (!parsedRequest?.context || !parsedRequest?.payload)
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';
                    parsedRequest.context.assertions = await this.validateRequestAssertions(topic, parsedRequest.context, minScopeRequired);
                    parsedRequest.context.topic = topic;
                    result = await fnHandler(parsedRequest);
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
                let topicDuration = Date.now() - topicStart;
                if (replyTo) {
                    this.publishResponse(replyTo, errors, result);
                    try {
                        this.emit('info', 'SERVICE', `Microservice | topicHandler (${topic}) | ${topicDuration} ms`);
                    }
                    catch (err) { }
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | ' + JSON.stringify(errors ? errors : result));
                    }
                    catch (err) { }
                }
                else {
                    try {
                        this.emit('info', 'SERVICE', `Microservice | topicHandler (${topic}) | ${topicDuration} ms`);
                    }
                    catch (err) { }
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | No Response Requested');
                    }
                    catch (err) { }
                }
            };
            super.registerTopicHandler(`${topicPrefix}.${handlerTopic}`, topicHandler, queue);
        }
        catch (err) {
            try {
                this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler (' + handlerTopic + ') Error: ' + err);
            }
            catch (err) { }
        }
    }
    generateToken(assertions) {
        try {
            if (!this.messageValidator.privateKey || !this.messageValidator.jwtAlgorithm)
                throw "MessageValidator Not Configured";
            return jwt.sign(assertions, this.messageValidator.privateKey, { algorithm: this.messageValidator.jwtAlgorithm });
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Generating Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
        return null;
    }
    verifyToken(token) {
        try {
            if (!this.messageValidator.publicKey || !this.messageValidator.jwtAlgorithm)
                throw "MessageValidator Not Configured";
            return jwt.verify(token, this.messageValidator.publicKey, { algorithms: [this.messageValidator.jwtAlgorithm] });
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Verifying Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
        return null;
    }
    decodeToken(token) {
        try {
            let decoded = jwt.decode(token, { complete: true });
            if (decoded?.payload)
                return decoded.payload;
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Decoding Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
        return null;
    }
    verifyParameters(test, fields) {
        if (!test)
            throw 'VALIDATION: Missing Verification Test Object';
        for (let field of fields) {
            let fieldEntries = field.split(",");
            if (fieldEntries.length > 1) {
                let anyFound = false;
                for (let fieldEntry of fieldEntries) {
                    if (test.hasOwnProperty(fieldEntry) && test[field] !== null)
                        anyFound = true;
                }
                if (!anyFound)
                    throw `VALIDATION: Missing At Least One Parameter Of - ${field}`;
            }
            else {
                if (!test.hasOwnProperty(field) || test[field] === null)
                    throw `VALIDATION: Missing Parameter - ${field}`;
            }
        }
    }
    async validateRequestAssertions(topic, context, minScopeRequired) {
        if (!context.ephemeralToken && minScopeRequired !== 'NOAUTH')
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';
        if (!context.ephemeralToken)
            return null;
        let token_assertions = null;
        try {
            let ephemeral_assertions = null;
            if (this.messageValidator.publicKey && this.messageValidator.jwtAlgorithm) {
                ephemeral_assertions = await this.verifyToken(context.ephemeralToken);
                if (ephemeral_assertions)
                    ephemeral_assertions.signatureVerified = true;
            }
            else {
                ephemeral_assertions = this.decodeToken(context.ephemeralToken);
                if (ephemeral_assertions)
                    ephemeral_assertions.signatureVerified = false;
            }
            if (!ephemeral_assertions)
                throw "Error Decoding Ephemeral Authorization Token";
            if (!ephemeral_assertions.exp)
                throw "Invalid Ephemeral Authorization Token: Missing exp";
            if (ephemeral_assertions.exp < Date.now())
                throw "Ephemeral Authorization Token Expired";
            if (!ephemeral_assertions.ephemeralAuth)
                throw "Invalid Ephemeral Authorization Token: Missing ephemeralAuth";
            let ephemeralAuth = JSON.parse(base64url.decode(ephemeral_assertions.ephemeralAuth));
            if (!ephemeralAuth.authentication || !ephemeralAuth.authorization)
                throw "Invalid Ephemeral Authorization Token Payload";
            let requestAuthentication = ephemeralAuth.authentication;
            let requestAuthorization = ephemeralAuth.authorization;
            let requestDomain = ephemeralAuth.domain || DOMAIN_INTERNAL;
            let signatureVerified = ephemeral_assertions.signatureVerified;
            if (context.proxyToken) {
                let proxy_assertions = null;
                if (this.messageValidator.publicKey && this.messageValidator.jwtAlgorithm) {
                    proxy_assertions = await this.verifyToken(context.proxyToken);
                }
                else {
                    proxy_assertions = this.decodeToken(context.proxyToken);
                }
                if (!proxy_assertions)
                    throw "Error Decoding Proxy Authorization Token";
                if (!proxy_assertions.exp)
                    throw "Invalid Proxy Authorization Token: Missing exp";
                if (proxy_assertions.exp < Date.now())
                    throw "Proxy Authorization Token Expired";
                if (!proxy_assertions.ephemeralAuth)
                    throw "Invalid Proxy Authorization Token: Missing ephemeralAuth";
                let proxyAuth = JSON.parse(base64url.decode(proxy_assertions.ephemeralAuth));
                if (!proxyAuth.authentication || !proxyAuth.authorization)
                    throw "Invalid Proxy Authorization Token Payload";
                requestAuthentication.proxy = proxyAuth.authentication;
                requestAuthorization = this.proxyAuthorization(requestAuthorization, proxyAuth.authorization);
                requestDomain = DOMAIN_INTERNAL;
            }
            token_assertions = {
                authentication: requestAuthentication,
                authorization: requestAuthorization,
                domain: requestDomain,
                signatureVerified: signatureVerified
            };
            token_assertions.authorization.scope = (topic) => {
                if (token_assertions.authorization.superAdmin)
                    return '*';
                return token_assertions.authorization.permissions[topic] || 'NONE';
            };
            let assertedScope = token_assertions.authorization.scope(topic);
            token_assertions.authorization.scopeRestriction = this.authorizeScope(assertedScope, token_assertions, minScopeRequired);
        }
        catch (err) {
            throw `UNAUTHORIZED: validateRequestAssertions Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }
    proxyAuthorization(baseAuthorization, proxyAuthorization) {
        if (baseAuthorization.superAdmin)
            return baseAuthorization;
        if (proxyAuthorization.superAdmin) {
            baseAuthorization.superAdmin = true;
            return baseAuthorization;
        }
        for (let permission in proxyAuthorization.permissions) {
            let basePermission = baseAuthorization.permissions[permission];
            let proxyPermission = proxyAuthorization.permissions[permission];
            if (!basePermission)
                baseAuthorization.permissions[permission] = proxyPermission;
            else {
                switch (basePermission) {
                    case "OWNER":
                        if (proxyPermission !== "OWNER") {
                            baseAuthorization.permissions[permission] = proxyPermission;
                        }
                        break;
                    case "MEMBER":
                        if (proxyPermission === "*" || proxyPermission === "SITE") {
                            baseAuthorization.permissions[permission] = proxyPermission;
                        }
                        break;
                    case "SITE":
                        if (proxyPermission === "*") {
                            baseAuthorization.permissions[permission] = proxyPermission;
                        }
                        break;
                    case "*":
                        break;
                }
            }
        }
        return baseAuthorization;
    }
    authorizeScope(assertedScope, assertions, minScopeRequired) {
        if (assertions.authorization.superAdmin)
            return null;
        switch (minScopeRequired) {
            case 'SUPERADMIN':
                if (!assertions.authorization.superAdmin)
                    throw 'UNAUTHORIZED: Requires SUPERADMIN Permissions';
                break;
            case '*':
                if (assertedScope !== '*')
                    throw 'UNAUTHORIZED:  Requires GLOBAL Permission Scope';
                break;
            case 'SITE':
                if (assertedScope !== '*' &&
                    assertedScope !== 'SITE')
                    throw 'UNAUTHORIZED:  Requires SITE Permission Scope or Greater';
                break;
            case 'MEMBER':
                if (assertedScope !== '*' &&
                    assertedScope !== 'SITE' &&
                    assertedScope !== 'MEMBER')
                    throw 'UNAUTHORIZED:  Requires MEMBER Permission Scope or Greater';
                break;
            case 'OWNER':
                if (assertedScope !== '*' &&
                    assertedScope !== 'SITE' &&
                    assertedScope !== 'MEMBER' &&
                    assertedScope !== 'OWNER')
                    throw 'UNAUTHORIZED:  Requires OWNER Permission Scope or Greater';
                break;
            case 'NOAUTH':
                return null;
                break;
            default:
                throw `SERVER ERROR:  Invalid Scope Requirement (${minScopeRequired})`;
        }
        let scopeRestriction = { user_id: assertions.authentication.user_id };
        switch (assertedScope) {
            case "MEMBER":
                scopeRestriction = { member_id: assertions.authentication.member_id };
                break;
            case "SITE":
                scopeRestriction = { site_id: assertions.authentication.site_id };
                break;
            case "*":
                scopeRestriction = null;
        }
        return scopeRestriction;
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
    versionNode() {
        return { version: this.sourceVersion, messages: this.serviceMessages };
    }
    registerTestHandler() {
        let instanceID = uuidv4();
        let testTopic = `TEST.${this.serviceName}.${instanceID}`;
        try {
            let topicHandler = async (request, replyTo, topic) => {
                let errors = null;
                let result = null;
                try {
                    try {
                        this.emit('debug', 'SERVICE TEST', 'Microservice | TopicHandler (' + topic + ') | ' + request);
                    }
                    catch (err) { }
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if (!parsedRequest)
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';
                    result = this.versionNode();
                }
                catch (err) {
                    let error = `Test Error(${topic}): ${JSON.stringify(err)}`;
                    try {
                        this.emit('error', 'SERVICE TEST', error);
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
                        this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | No Response Requested');
                    }
                    catch (err) { }
                }
            };
            super.registerTopicHandler(testTopic, topicHandler, instanceID);
        }
        catch (err) {
            try {
                this.emit('error', 'SERVICE TEST', 'Microservice | registerTopicHandler (' + testTopic + ') Error: ' + err);
            }
            catch (err) { }
        }
    }
}
