
declare class Microservice {
    constructor(serviceName: string);

    init(): Promise<void>;
    shutdown(): void;

    publishEvent(topic: string, context: any, payload: any, topicPrefixOverride?: string): void;
    queryTopic(topic: string, context: any, payload: any, timeoutOverride?: number, topicPrefixOverride?: string): Promise<any>;
    registerTopicHandler(topic: string, fnHandler: any, queue: any, topicPrefixOverride?: string): void;
    generateToken(assertions: any): any;
    verifyToken(token: any): any;
    decodeToken(token: any): any;
}