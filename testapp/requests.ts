import { RequestType, RequestType0 } from "vscode-jsonrpc";

// Define request types
export const InitializeRequest = new RequestType<{ arena: string }, { success: boolean }, void>("initialize");
export const WriteFileRequest = new RequestType<{ path: string; data: string }, { success: boolean }, void>("writeFile");
export const ReadFileRequest = new RequestType<{ path: string }, { data: string }, void>("readFile");
export const ExistsRequest = new RequestType<{ path: string }, { exists: boolean }, void>("exists");
export const ShutdownRequest = new RequestType0<{ success: boolean }, void>("shutdown");
