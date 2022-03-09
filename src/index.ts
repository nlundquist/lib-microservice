import { NATSClient, NATSTopicHandler }     from '@randomrod/lib-nats-client';
import AWS                                  from 'aws-sdk';
import base64url                            from 'base64url';
import jwt, {JwtPayload}                    from 'jsonwebtoken';
import { v4 as uuidv4 }                     from 'uuid';

const CLIENT_PREFIX = 'CLIENT';
const MESH_PREFIX   = 'MESH';

const SUPERADMIN    = 'SUPERADMIN';
const QUERY_TIMEOUT = 7500;

interface PUBLIC_KEY {
    keyID: string,
    key: any
};

interface JWT_TOKEN {
    header?: string,
    payload?: string,
    signature?: string
}

export interface ServiceRequest {
    context: any,
    payload: any
}

export interface ServiceHandler {
    (request: ServiceRequest): Promise<any>;
}

export interface ScopeRestriction {
    site_id?:   string,
    member_id?: string,
    user_id?:   string
}

export class Microservice extends NATSClient {
    sourceVersion: string = process.env.SOURCE_VERSION || 'LOCAL';

    messageValidator: any = {
        privateKey:         process.env.JWT_PRIVATE_KEY || null,
        publicKey:          process.env.JWT_PUBLIC_KEY  || null,
        jwtAlgorithm:       process.env.JWT_ALGORITHM   || 'ES256',

        kmsAlgorithm:       process.env.KMS_ALGORITHM   || 'ECDSA_SHA_256',
        kmsSigningKeyID:    process.env.KMS_KEY_ARN     || null
    };

    publicKeys: PUBLIC_KEY[] = [];
    kms: any = null;

    constructor(serviceName: string) {
        super(serviceName);
    }

    async init(): Promise<void> {
        await super.init();
        if(!this.messageValidator.privateKey && !this.messageValidator.kmsSigningKeyID)
            try{this.emit('info', 'no correlation', 'Message Signing NOT Configured');}catch(err){}

        if(!this.messageValidator.publicKey && !this.messageValidator.kmsSigningKeyID)
            try{this.emit('info', 'no correlation', 'Message Validation NOT Configured');}catch(err){}

        if(this.messageValidator.kmsSigningKeyID)
            this.kms = new AWS.KMS({apiVersion: '2014-11-01'});

        this.registerTestHandler();
    }

    async query(topic: string, context: any, payload: any, queryTimeout: number = QUERY_TIMEOUT, topicPrefix: string = CLIENT_PREFIX): Promise<any> {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        //Reset the Context to remove previously decoded information (keep it clean!)
        let newContext: any = {
            correlationUUID:    context.correlationUUID     || 'MICROSERVICE',
            siteID:             context.siteID              || null,
            idToken:            context.idToken             || null,
            ephemeralToken:     context.ephemeralToken      || null,
        };

        let queryData = JSON.stringify({ context: newContext, payload });
        try{this.emit('debug', newContext.correlationUUID, `NATS REQUEST (${topic}): ${queryData}`);}catch(err){}

        let topicStart = Date.now();

        let queryResponse: string = await super.queryTopic(`${topicPrefix}.${topic}`, queryData, queryTimeout);
        if(!queryResponse) throw `INVALID RESPONSE (${topic}) from NATS Mesh`;

        let topicDuration = Date.now() - topicStart;

        try{this.emit('info', newContext.correlationUUID, `NATS RESPONSE (${topic}) | ${topicDuration} ms`);}catch(err){}
        try{this.emit('debug', newContext.correlationUUID, `NATS RESPONSE (${topic}) | ${topicDuration} ms : ${queryResponse}`);}catch(err){}

        let parsedResponse = JSON.parse(queryResponse);
        if(parsedResponse.response.errors) throw parsedResponse.response.errors;
        return parsedResponse.response.result;
    }

    publish(topic: string, context: any, payload: any, topicPrefix: string = CLIENT_PREFIX): void {
        if(typeof context !== 'object' || typeof payload !== 'object')
            throw 'INVALID REQUEST: One or more of context or payload are not properly structured objects.';

        let eventData = JSON.stringify({ context, payload });
        try{this.emit('debug', 'no correlation', `NATS PUBLISH (${topic}): ${eventData}`);}catch(err){}

        return super.publishTopic(`${topicPrefix}.${topic}`, eventData);
    }

    registerHandler(topic: string, fnHandler: ServiceHandler, minScopeRequired: string = SUPERADMIN, queue: string | null = null, topicPrefix: string = MESH_PREFIX): void {
        try {
            let topicHandler: NATSTopicHandler = async (request: string, replyTo: string, topic: string): Promise<void> => {
                let errors = null;
                let result = null;
                let topicStart = Date.now();

                try {
                    try{this.emit('debug', 'SERVICE', 'Microservice | TopicHandler (' + topic + ') | ' + request);}catch(err){}

                    let parsedRequest: ServiceRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest?.context || !parsedRequest?.payload )
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
                    try{this.emit('info', 'SERVICE', `Microservice | topicHandler (${topic}) | ${topicDuration} ms`);}catch(err){}
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | ' + JSON.stringify(errors ? errors : result));}catch(err){}
                } else {
                    try{this.emit('info', 'SERVICE', `Microservice | topicHandler (${topic}) | ${topicDuration} ms`);}catch(err){}
                    try{this.emit('debug', 'SERVICE', 'Microservice | topicHandler (' + topic + ') Response | ' + topicDuration.toString() + 'ms | No Response Requested');}catch(err){}
                }
            };

            super.registerTopicHandler(`${topicPrefix}.${topic}`, topicHandler, queue);

        } catch(err) {
            try{this.emit('error', 'SERVICE', 'Microservice | registerTopicHandler (' + topic + ') Error: ' + err);}catch(err){}
        }
    }

    async generateToken(assertions: any): Promise<string | null> {
        try {
            if((!this.messageValidator.privateKey && !this.messageValidator.kmsSigningKeyID) ||
                (this.messageValidator.kmsSigningKeyID && !this.messageValidator.kmsAlgorithm) ||
                !this.messageValidator.jwtAlgorithm) throw "MessageValidator Not Configured";

            if(this.messageValidator.privateKey)
                return jwt.sign(assertions, this.messageValidator.privateKey, {algorithm: this.messageValidator.jwtAlgorithm});

            if(this.messageValidator.kmsSigningKeyID)
                return this.kmsSign(assertions, this.messageValidator.kmsSigningKeyID, this.messageValidator.jwtAlgorithm, this.messageValidator.kmsAlgorithm);

        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Generating Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
        return null;
    }

    async verifyToken(token: any): Promise<JwtPayload | string | null> {
        try {
            if((!this.messageValidator.publicKey && !this.messageValidator.kmsSigningKeyID) ||
                (this.messageValidator.kmsSigningKeyID && !this.messageValidator.kmsAlgorithm) ||
                !this.messageValidator.jwtAlgorithm) throw "MessageValidator Not Configured";

            let publicKey: any = this.messageValidator.publicKey;
            let algorithm: any = this.messageValidator.jwtAlgorithm;

            if(this.messageValidator.kmsSigningKeyID) {  //This signifies KMS is in use, and we need get the public key...
                let tokenClaims: any = this.decodeToken(token);
                publicKey = await this.kmsPublicKey(tokenClaims.keyID);
                algorithm = tokenClaims.jwtAlgorithm;
            }

            if(publicKey && algorithm)
                return jwt.verify(token, publicKey, {algorithms: [algorithm]});

        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Verifying Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
        return null;
    }

    decodeToken(token: any): JwtPayload | string | null {
        try {
            let decoded: any = jwt.decode(token, {complete: true});
            return decoded.payload;
        } catch(err) {
            try{this.emit('error', 'MICROSERVICE', `Error Decoding Ephemeral Token: ${JSON.stringify(err)}`);}catch(err){}
        }
        return null;
    }

    async kmsSign(assertions: any, keyID: string, jwtAlgorithm: string, kmsAlgorithm: string) {
        
        assertions.keyID = keyID;
        assertions.jwtAlgorithm = jwtAlgorithm;
        assertions.kmsAlgorithm = kmsAlgorithm;

        let token_components: JWT_TOKEN = {
            header: base64url(`{ "alg": "${jwtAlgorithm}", "typ": "JWT"}`),
            payload: base64url(JSON.stringify(assertions))
        };

        let message = Buffer.from(token_components.header + "." + token_components.payload)

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

    async kmsPublicKey(keyID: string) {
        //Check local cache first...
        for(let publicKey of this.publicKeys) {
            if(publicKey.keyID === keyID) return publicKey.key;
        }

        //Lookup the Public Key, Cache it, and Return it
        let publicKMSKey = await this.kms.getPublicKey({KeyId: keyID}).promise();
        this.publicKeys.push({keyID: keyID, key: publicKMSKey});
        return publicKMSKey;
    }

    verifyParameters(test: any, fields: string[]): void {
        if(!test) throw 'VALIDATION: Missing Verification Test Object';

        for(let field of fields) {
            let fieldEntries = field.split(",");
            if(fieldEntries.length > 1) {
                let anyFound = false;
                for(let fieldEntry of fieldEntries) {
                    if(test.hasOwnProperty(fieldEntry) && test[field] !== null) anyFound = true;
                }
                if(!anyFound)  throw `VALIDATION: Missing At Least One Parameter Of - ${field}`;
            } else {
                if(!test.hasOwnProperty(field) || test[field] === null )
                    throw `VALIDATION: Missing Parameter - ${field}`;
            }
        }
    }

    //PRIVATE FUNCTIONS
    private validateRequest(topic: string, context: any, minScopeRequired: string): any {

        if(!context.ephemeralToken && !topic.endsWith('NOAUTH') && minScopeRequired !== 'NOAUTH')
            throw 'UNAUTHORIZED: Ephemeral Authorization Token Missing';

        if(!context.ephemeralToken) return {};

        let token_assertions: any = null;
        try {
            token_assertions = (this.messageValidator.publicKey && this.messageValidator.jwtAlgorithm)
                ? this.verifyToken(context.ephemeralToken)
                : this.decodeToken(context.ephemeralToken);

            if(!token_assertions)                 throw "Error Decoding Ephemeral Authorization Token";
            if(token_assertions.exp < Date.now()) throw "Ephemeral Authorization Token Expired";

            if(!token_assertions.ephemeralAuth) throw "Invalid Ephemeral Authorization Token";
            let ephemeralAuth = JSON.parse(base64url.decode(token_assertions.ephemeralAuth));

            if(!ephemeralAuth.authentication || !ephemeralAuth.authorization) throw "Invalid Ephemeral Authorization Token Payload";

            token_assertions.authentication = ephemeralAuth.authentication;
            token_assertions.authorization = ephemeralAuth.authorization;
            token_assertions.authorization.scopeRestriction = this.authorizeScope(token_assertions, minScopeRequired, topic);
            token_assertions.authorization.scopePermission = (topic: string) => {
                if(token_assertions.authorization.superAdmin) return '*';
                return token_assertions.authorization.permissions[topic] || 'NONE';
            };

        } catch(err) {
            throw `UNAUTHORIZED: validateRequest Error: ${JSON.stringify(err)}`;
        }
        return token_assertions;
    }

    private authorizeScope(assertions: any, minScopeRequired: string, topic: string): ScopeRestriction | null {
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

            case 'NOAUTH':
                return null; //Shortcut - no restrictions, no authorization check
                break;

            default:
                throw `SERVER ERROR:  Invalid Scope Requirement (${minScopeRequired})`;
        }

        let scopeRestriction: ScopeRestriction | null = null;
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

    private publishResponse(replyTopic: string, errors: any, result: any): void {
        let response = JSON.stringify({
            response: {
                errors: errors,
                result: result
            }
        });
        return super.publishTopic(replyTopic, response);
    }

    //***************************************************
    // TEST Function
    //***************************************************
    private versionNode() {
        return { version: this.sourceVersion };
    }

    private registerTestHandler() {
        let instanceID: string = uuidv4();
        let testTopic: string = `TEST.${this.serviceName}.${instanceID}`;

        try {
            let topicHandler: NATSTopicHandler = async (request: string, replyTo: string, topic: string): Promise<void> => {
                let errors = null;
                let result = null;

                try {
                    try{this.emit('debug', 'SERVICE TEST', 'Microservice | TopicHandler (' + topic + ') | ' + request);}catch(err){}

                    let parsedRequest: ServiceRequest = request ? JSON.parse(request) : null;
                    if(!parsedRequest) throw 'INVALID REQUEST: Either context or payload, or both, are missing.';

                    result = this.versionNode();

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