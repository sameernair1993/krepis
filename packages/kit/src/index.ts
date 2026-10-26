export { observe, Observer, type ObserveOptions, type Unit } from './collector.ts';
export { apolloPlugin, type ApolloPlugin, type ApolloPluginOptions } from './apollo.ts';
export type { AutoBatchOptions, MismatchVerdict, OptimizeMismatch, OptimizeOptions, OptimizeSetting, OptimizeStats } from './optimize.ts';
export { formatFinding, formatNPlusOne, formatRepeatedLookup, projectedExtraMs, type ReportOptions } from './report.ts';
export { describeCommand, lookupKeys, pointLookup, shapeFilter, valueKey, type LookupKeys } from './fingerprint.ts';
export type { Confidence, Finding, NPlusOneFinding, RepeatedLookupFinding, RepeatEvidence, CommandRecord } from './types.ts';
export { CAPTURE_VERSION, type CaptureOptions, type CaptureSetting, type CaptureStats } from './capture.ts';
export { analysisJson, captureFiles, formatAnalysis, groupFindings, loadCaptures, nPlusOneGroups, type AnalyzeOptions, type FindingGroup, type LoadedCaptures } from './analyze.ts';
