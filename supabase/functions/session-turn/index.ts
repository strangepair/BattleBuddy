// Phase 1 scaffold: receives a chat turn, calls Claude Haiku, streams back.
// Fully implemented in Phase 1. This file establishes the interface contract.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  // Phase 0: stub response so the contract is testable before Phase 1 wires Claude.
  return new Response(
    JSON.stringify({ stub: true, message: 'session-turn not yet implemented — Phase 1.' }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
  );
});
