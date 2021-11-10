
declare class Microservice {
    constructor(serviceName: string);

    init(): Promise<void>;
    shutdown(): void;

    publishEvent(topic: string, context: any, payload: any, topicPrefix: string): void;
    queryTopic(topic: string, context: any, payload: any, queryTimeout: number, topicPrefix: string): Promise<any>;
    registerTopicHandler(topic: string, fnHandler: any, minScopeRequired: string, queue: string | null, topicPrefix: string): void;
    generateToken(assertions: any): any;
    verifyToken(token: any): any;
    decodeToken(token: any): any;
}