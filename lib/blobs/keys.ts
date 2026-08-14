// Pure key builders. Keys are NEVER constructed from raw request input: the
// `[id]` path parameter is only ever used to look up an index entry, and the
// media key is then built from `entry.mediaId` plus a Variant union member. A
// caller cannot inject a key fragment, traverse a namespace, or reach the meta
// store through the Media_API.

import type { Variant } from './types';

const ns = (archiveId: string) => `arch/${archiveId}`;

export const configKey = (a: string) => `${ns(a)}/config`;
export const indexKey = (a: string) => `${ns(a)}/index`;
export const visKey = (a: string, mediaId: string) => `${ns(a)}/vis/${mediaId}`;
export const visSummaryKey = (a: string) => `${ns(a)}/vis-summary`;
export const attendeeCodeKey = (a: string) => `${ns(a)}/secret/attendee-code`;
export const removalKey = (a: string, recordId: string) => `${ns(a)}/removals/${recordId}`;
export const removalPrefix = (a: string) => `${ns(a)}/removals/`;
export const rateKey = (a: string, scope: string, ipHash: string) =>
  `${ns(a)}/rl/${scope}/${ipHash}`;
export const ratePrefix = (a: string) => `${ns(a)}/rl/`;
export const mediaKey = (a: string, mediaId: string, variant: Variant) =>
  `${ns(a)}/media/${mediaId}/${variant}`;
