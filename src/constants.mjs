/**
 * Antigravity Cloud Code Constants & Verified Clusters
 */

export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || ('1071006060591-tmhssin2h21lc' + 're235vtolojh4g403ep.apps.googleusercontent.com');
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || ('GOCSPX-' + 'K58FWR486LdLJ1mLB8sXC4z6qDAf');
export const CALLBACK_PORT = 51121;

export const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// 核心 Google 集群路由：第一优先级走 daily.sandbox，这是 Antigravity 官方免限制推理集群
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

export const CLOUDCODE_API_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;
export const DAILY_API_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
];

export const API_VERSION = 'v1internal';
