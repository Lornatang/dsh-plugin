export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    intervalMs: number;
}
export interface OAuthTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
}
export declare function parseRequestedScopes(value: string): string[] | undefined;
export declare function startDeviceAuthorization(clientId: string, signal: AbortSignal, additionalScopes?: readonly string[]): Promise<DeviceAuthorization>;
export declare function waitForDeviceToken(clientId: string, authorization: DeviceAuthorization, signal: AbortSignal): Promise<OAuthTokens>;
export declare function refreshDeviceToken(clientId: string, refreshToken: string, signal: AbortSignal): Promise<OAuthTokens>;
