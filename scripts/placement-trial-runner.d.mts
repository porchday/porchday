export type PlacementTrialCollector = (input:{signal:AbortSignal;at:number;startedAt:number;lastWindowAt:number})=>Promise<unknown>;
export function runPlacementTrial(input:{directory:string;operationId:string;baseline:unknown;assertLease:()=>void;assertInventory:(signal:AbortSignal)=>Promise<unknown>;collect:PlacementTrialCollector;signal:AbortSignal}):Promise<'healthy'|'unhealthy'>;
