import type { LogEntityType, LogLevel } from '../../shared/logs.js';

export const ENTITY_TYPE_LABEL: Record<LogEntityType, string> = { calendar: 'Calendar', contact: 'Contact', email: 'Email' };
export const LEVEL_LABEL: Record<LogLevel, string> = { info: 'Info', error: 'Error' };
