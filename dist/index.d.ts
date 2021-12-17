import { NATSClient } from '@randomrod/lib-nats-client';
import { JwtPayload } from 'jsonwebtoken';
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
    constructor(serviceName: string);
    init(): Promise<void>;
    query(topic: string, context: any, payload: any, queryTimeout?: number, topicPrefix?: string): Promise<any>;
    publish(topic: string, context: any, payload: any, topicPrefix?: string): void;
    registerHandler(topic: string, fnHandler: ServiceHandler, minScopeRequired?: string, queue?: string | null, topicPrefix?: string): void;
    generateToken(assertions: any): string | null;
    verifyToken(token: any): JwtPayload | string | null;
    decodeToken(token: any): JwtPayload | string | null;
    private validateRequest;
    private authorizeScope;
    private publishResponse;
    private versionNode;
    private registerTestHandler;
}
