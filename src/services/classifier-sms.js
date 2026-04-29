const OpenAI = require('openai');

const MODEL = 'gpt-4o-mini';

const INTENTS = ['positive', 'negative', 'question', 'unclassifiable'];

let client;

function getOpenAI() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Classify inbound SMS for local trade / no-website campaign.
 */
async function classifySmsIntent(inboundMessage, contextLines) {
  const ctx = (contextLines || []).filter(Boolean).join('\n');

  const system = `You classify SMS replies from small local businesses (plumbers, HVAC, roofers, cleaners) who were cold-texted about not having a website.

Categories (exactly one):
- positive — they confirm they have no website, want help, or show interest in a site
- negative — not interested, already have a website, or ask to stop / unsubscribe
- question — they asked something that needs a human (pricing, details, who is this, etc.)
- unclassifiable — ambiguous, unclear, or off-topic noise

Respond with JSON only: {"intent":"positive|negative|question|unclassifiable","reasoning":"one short sentence"}`;

  const user = `Business context (from our sheet, may be empty):
${ctx || '(none)'}

Their latest SMS:
${inboundMessage}`;

  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 200,
    temperature: 0.2,
  });

  const text = completion.choices[0]?.message?.content?.trim() || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  let intent = String(parsed.intent || '').toLowerCase();
  if (!INTENTS.includes(intent)) intent = 'unclassifiable';

  return {
    intent,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

/**
 * Small classifier: did they affirm interest in receiving the free site?
 */
async function classifyAffirmative(inboundMessage) {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Decide if the user message is an affirmative yes to receiving something (yes, sure, send it, ok, yep, please, etc.). JSON only: {"affirmative":true|false}`,
      },
      { role: 'user', content: inboundMessage },
    ],
    max_tokens: 80,
    temperature: 0,
  });

  const text = completion.choices[0]?.message?.content?.trim() || '{}';
  try {
    const p = JSON.parse(text);
    return !!p.affirmative;
  } catch {
    return /\b(yes|yeah|yep|sure|ok|okay|please|send|sounds good)\b/i.test(inboundMessage);
  }
}

module.exports = { classifySmsIntent, classifyAffirmative, SMS_INTENTS: INTENTS, SMS_MODEL: MODEL };
