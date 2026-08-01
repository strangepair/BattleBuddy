test('client VOICE_FIRST_AUDIO_TIMEOUT_MS must exceed agent TTS_TIMEOUT_SECONDS', () => {
  const { readFileSync } = require('fs') as { readFileSync: (p: string, enc: string) => string };
  const { resolve } = require('path') as { resolve: (...parts: string[]) => string };
  const cwd = (process as unknown as { cwd(): string }).cwd();

  const clientSrc = readFileSync(
    resolve(cwd, 'src/components/session/VoiceSession.tsx'), 'utf8'
  );
  const agentSrc = readFileSync(
    resolve(cwd, '../agent/sesame_tts.py'), 'utf8'
  );

  const clientMatch = clientSrc.match(/VOICE_FIRST_AUDIO_TIMEOUT_MS\s*=\s*([\d_]+)/);
  const agentMatch = agentSrc.match(/TTS_TIMEOUT_SECONDS\s*=\s*(\d+)/);

  expect(clientMatch).not.toBeNull();
  expect(agentMatch).not.toBeNull();

  const clientMs = parseInt(clientMatch![1].replace(/_/g, ''), 10);
  const agentMs = parseInt(agentMatch![1], 10) * 1000;

  expect(clientMs).toBeGreaterThan(agentMs);
});
