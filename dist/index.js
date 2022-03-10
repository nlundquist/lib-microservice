import { NATSClient } from '@randomrod/lib-nats-client';
import AWS from 'aws-sdk';
import base64url from 'base64url';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
const INTERNAL_PREFIX = 'INTERNAL';
const MESH_PREFIX = 'MESH';
const SUPERADMIN = 'SUPERADMIN';
const QUERY_TIMEOUT = 7500;
;
export class Microservice extends NATSClient {
    constructor(serviceName) {
        super(serviceName);
        this.sourceVersion = process.env.SOURCE_VERSION || 'LOCAL';
        this.messageValidator = {
            privateKey: process.env.JWT_PRIVATE_KEY || null,
            publicKey: process.env.JWT_PUBLIC_KEY || null,
            jwtAlgorithm: process.env.JWT_ALGORITHM || 'ES256',
            kmsAlgorithm: process.env.KMS_ALGORITHM || 'ECDSA_SHA_256',
            kmsSigningKeyID: process.env.KMS_KEY_ARN || null
        };
        this.publicKeys = [];
        this.kms = null;
    }
    async init() {
        await super.init();
        if (!this.messageValidator.privateKey && !this.messageValidator.kmsSigningKeyID)
            try {
                this.emit('info', 'no correlation', 'Message Signing NOT Configured');
            }
            catch (err) { }
        if (!this.messageValidator.publicKey && !this.messageValidator.kmsSigningKeyID)
            try {
                this.emit('info', 'no correlation', 'Message Validation NOT Configured');
            }
            catch (err) { }
        if (this.messageValidator.kmsSigningKeyID)
            this.kms = new AWS.KMS({ apiVersion: '2014-11-01' });
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
    registerHandler(topic, fnHandler, minScopeRequired = SUPERADMIN, queue = null, topicPrefix = MESH_PREFIX) {
        try {
            let topicHandler = async (request, replyTo, topic) => {
                let errors = null;
                let result = null;
                let topicStart = Date.now();
                try {
                    try {
                        this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);
                    }
                    catch (err) { }
                    let parsedRequest = request ? JSON.parse(request) : null;
                    if (!parsedRequest?.context || !parsedRequest?.payload)
                        throw 'INVALID REQUEST: Either context or payload, or both, are missing.';
                    parsedRequest.context.assertions = await this.validateRequestAssertions(topic, parsedRequest.context, minScopeRequired);
                    parsedRequest.context.topic = topic.substring(topic.indexOf(".") + 1);
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
            super.registerTopicHandler(`${topicPrefix}.${topic}`, topicHandler, queue);
        }
        catch (err) {
            try {
                this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler (' + topic + ') Error: ' + err);
            }
            catch (err) { }
        }
    }
    async generateToken(assertions) {
        try {
            if ((!this.messageValidator.privateKey && !this.messageValidator.kmsSigningKeyID) ||
                (this.messageValidator.kmsSigningKeyID && !this.messageValidator.kmsAlgorithm) ||
                !this.messageValidator.jwtAlgorithm)
                throw "MessageValidator Not Configured";
            if (this.messageValidator.privateKey)
                return jwt.sign(assertions, this.messageValidator.privateKey, { algorithm: this.messageValidator.jwtAlgorithm });
            if (this.messageValidator.kmsSigningKeyID)
                return await this.kmsSign(assertions, this.messageValidator.kmsSigningKeyID, this.messageValidator.jwtAlgorithm, this.messageValidator.kmsAlgorithm);
        }
        catch (err) {
            try {
                this.emit('error', 'MICROSERVICE', `Error Generating Ephemeral Token: ${JSON.stringify(err)}`);
            }
            catch (err) { }
        }
        return null;
    }
    async verifyToken(token) {
        try {
            if ((!this.messageValidator.publicKey && !this.messageValidator.kmsSigningKeyID) ||
                (this.messageValidator.kmsSigningKeyID && !this.messageValidator.kmsAlgorithm) ||
                !this.messageValidator.jwtAlgorithm)
                throw "MessageValidator Not Configured";
            let publicKey = this.messageValidator.publicKey;
            let algorithm = this.messageValidator.jwtAlgorithm;
            if (this.messageValidator.kmsSigningKeyID) {
                let tokenClaims = this.decodeToken(token);
                publicKey = await this.kmsPublicKey(tokenClaims.keyID);
                algorithm = tokenClaims.jwtAlgorithm;
            }
            if (publicKey && algorithm)
                return jwt.verify(token, publicKey, { algorithms: [algorithm] });
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
    async kmsSign(assertions, keyID, jwtAlgorithm, kmsAlgorithm) {
        assertions.keyID = keyID;
        assertions.jwtAlgorithm = jwtAlgorithm;
        assertions.kmsAlgorithm = kmsAlgorithm;
        let token_components = {
            header: base64url(`{ "alg": "${jwtAlgorithm}", "typ": "JWT"}`),
            payload: base64url(JSON.stringify(assertions))
        };
        let message = Buffer.from(token_components.header + "." + token_components.payload);
        let res = await this.kms.sign({
            Message: message,
            KeyId: keyID,
            SigningAlgorithm: kmsAlgorithm,
            MessageType: 'RAW'
        }).promise();
        token_components.signature = res.Signature.toString("base64")
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
        return token_components.header + "." + token_components.payload + "." + token_components.signature;
    }
    async kmsPublicKey(keyID) {
        for (let publicKey of this.publicKeys) {
            if (publicKey.keyID === keyID)
                return publicKey.key;
        }
        let publicKMSKey = await this.kms.getPublicKey({ KeyId: keyID }).promise();
        this.publicKeys.push({ keyID: keyID, key: publicKMSKey });
        return publicKMSKey;
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
            token_assertions = ((this.messageValidator.publicKey && this.messageValidator.jwtAlgorithm) ||
                (this.messageValidator.kmsSigningKeyID && this.messageValidator.jwtAlgorithm))
                ? await this.verifyToken(context.ephemeralToken)
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
            token_assertions.authorization.scope = (topic) => {
                if (token_assertions.authorization.superAdmin)
                    return '*';
                return token_assertions.authorization.permissions[topic] || 'NONE';
            };
            let assertedScope = token_assertions.authorization.scope(topic);
            if (token_assertions.authorization.superAdmin)
                token_assertions.authorization.scopeRestriction = null;
            else
                token_assertions.authorization.scopeRestriction = this.authorizeScope(assertedScope, token_assertions, minScopeRequired);
        }
        catch (err) {
            throw `UNAUTHORIZED: validateRequestAssertions Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }
    authorizeScope(assertedScope, assertions, minScopeRequired) {
        switch (minScopeRequired) {
            case 'SUPERADMIN':
                throw 'UNAUTHORIZED:  Requires SUPERADMIN Privileges';
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
        let scopeRestriction = null;
        switch (assertedScope) {
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
        return { version: this.sourceVersion };
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
