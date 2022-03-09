import { NATSClient } from '@randomrod/lib-nats-client';
import { JwtPayload } from 'jsonwebtoken';
interface PUBLIC_KEY {
    keyID: string;
    key: any;
}
export interface ServiceRequest {
    context: any;
    payload: any;
}
export interface ServiceHandler {
    (request: ServiceRequest): Promise<any>;
}
export interface ScopeRestriction {
    site_id?: string;
    member_id?: string;
    user_id?: string;
}
export declare class Microservice extends NATSClient {
    sourceVersion: string;
    messageValidator: any;
    publicKeys: PUBLIC_KEY[];
    kms: any;
    constructor(serviceName: string);
    init(): Promise<void>;
    query(topic: string, context: any, payload: any, queryTimeout?: number, topicPrefix?: string): Promise<any>;
    publish(topic: string, context: any, payload: any, topicPrefix?: string): void;
    registerHandler(topic: string, fnHandler: ServiceHandler, minScopeRequired?: string, queue?: string | null, topicPrefix?: string): void;
    generateToken(assertions: any): Promise<string | null>;
    verifyToken(token: any): Promise<JwtPayload | string | null>;
    decodeToken(token: any): JwtPayload | string | null;
    kmsSign(assertions: any, keyID: string, jwtAlgorithm: string, kmsAlgorithm: string): Promise<string>;
    kmsPublicKey(keyID: string): Promise<any>;
    verifyParameters(test: any, fields: string[]): void;
    private validateRequest;
    private authorizeScope;
    private publishResponse;
    private versionNode;
    private registerTestHandler;
}
export {};
