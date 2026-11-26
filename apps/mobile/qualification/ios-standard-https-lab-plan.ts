import { port } from './standard-json-scenarios.ts';

export const marker = '[BunnyIosStandardHttpsLab] ';
export const origin = 'https://localhost:' + port;
export const session = '/v1/session';
export const labPath = (name: string) => '/v1/lab/' + name;

export const phases = {
  'before-trust': ['tls-untrusted'],
  'wrong-name': ['tls-wrong-name'],
  refusals: ['origin-refused', 'get-path-refused', 'delete-path-refused'],
  nominal: [
    'get',
    'post',
    'delete',
    'redirect-same',
    'redirect-other',
    'redirect-http',
    'identity',
    'auth-challenge',
  ],
  loss: ['cancel-retried-get', 'post-loss', 'delete-loss'],
} as const;

export type Phase = keyof typeof phases;
export type Scenario = (typeof phases)[Phase][number];

export function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && Object.hasOwn(phases, value);
}

export function routes(phase: Phase) {
  if (phase === 'loss') {
    return new Map([
      ['GET ' + session, '/loss-get-cancel'],
      ['DELETE ' + session, '/session-delete-loss'],
      ['POST ' + labPath('lost-post'), '/loss-post'],
    ]);
  }
  if (phase !== 'nominal') return new Map<string, string>();
  return new Map([
    ['GET ' + session, '/coding-absent'],
    ['DELETE ' + session, '/session-delete'],
    ['POST ' + labPath('messages'), '/request-body'],
    ['POST ' + labPath('redirect-same'), '/redirect/303/same'],
    ['POST ' + labPath('redirect-other'), '/redirect/307/host'],
    ['POST ' + labPath('redirect-http'), '/redirect/302/http'],
    ['GET ' + labPath('ambient'), '/identity'],
    ['POST ' + labPath('identity'), '/identity'],
    ['POST ' + labPath('challenge'), '/challenge'],
  ]);
}
