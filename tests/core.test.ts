import test from 'node:test';
import assert from 'node:assert/strict';
import { createJev, choice, parseAnswers, trusted, ENDPOINT, type Decide } from '../packages/core/src/jev';
import { classifyTabs, classifyRepos, classifyFeedback, TAB_CATEGORIES, REPO_CATEGORIES, REPO_KINDS } from '../packages/core/src/classify';
import { sampleAnswer, demoRepos } from '../packages/core/src/demo';

const question = choice('Which?', { a: 'A', b: 'B' });
const answer = sampleAnswer(question.criteria, 'a');
test('Jev uses the official typed endpoint and rejects redirects', async () => {
  let calls = 0;
  const decide = createJev({ apiKey: 'test-only-key', model: 'jev-latest', fetcher: async (url, init) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.q.type, 'choice'); assert.equal(body.state.text, 'Hello');
    return Response.json({ answers: { q: answer } });
  } });
  assert.deepEqual(await decide({ state: { text: 'Hello' }, questions: { q: question } }), { q: answer });
  assert.equal(calls, 1);
});
test('Jev handles missing key, auth errors, rate limits and timeouts without echoing provider text', async () => {
  assert.throws(() => createJev({ apiKey: ' ' }), /TYPESAFE_API_KEY/);
  for (const status of [401, 403, 429, 500]) {
    const decide = createJev({ apiKey: 'x', fetcher: async () => new Response('private provider body', { status }) });
    await assert.rejects(decide({ state: '', questions: { q: question } }), error => error instanceof Error && error.message.includes(String(status)) && !error.message.includes('private'));
  }
  const decide = createJev({ apiKey: 'x', fetcher: async () => { throw new DOMException('secret', 'TimeoutError'); } });
  await assert.rejects(decide({ state: '', questions: { q: question } }), /超时/);
});
test('Malformed model outputs cannot cross the adapter boundary', () => {
  for (const a of [null, { ...answer, type: 'score' }, { ...answer, choice: 'unknown' }, { ...answer, confidence: NaN }, { ...answer, confidence: 2 }, { ...answer, probabilities: { a: 0.9 } }, { ...answer, probabilities: { a: 0.2, b: 0.1 } }]) {
    assert.throws(() => parseAnswers({ answers: { q: a } }, { q: question }));
  }
  assert.throws(() => parseAnswers({ answers: {} }, { q: question }));
});
test('Both confidence and selected probability must pass the threshold', () => {
  assert.equal(trusted({ ...answer, confidence: 0.6 }), false);
  assert.equal(trusted({ ...answer, probabilities: { a: 0.6, b: 0.4 } }), false);
  assert.equal(trusted(answer), true);
});
test('Tab classification excludes internal pages, strips URL secrets, and batches large windows', async () => {
  let calls = 0;
  const decide: Decide = async ({ state, questions }) => {
    calls++;
    const serialized = JSON.stringify(state); assert.ok(!serialized.includes('secret')); assert.ok(!serialized.includes('/private'));
    assert.ok(Object.keys(questions).length <= 15);
    return Object.fromEntries(Object.keys(questions).map(k => [k, sampleAnswer(TAB_CATEGORIES, 'develop')]));
  };
  const tabs = Array.from({ length: 31 }, (_, i) => ({ id: i, title: 'Developer docs', url: 'https://user:secret@example.com/private?token=secret#secret' }));
  const result = await classifyTabs([...tabs, { id: 100, title: 'Settings', url: 'chrome://settings' }], decide);
  assert.equal(result.length, 31); assert.equal(calls, 3); assert.ok(result.every(r => r.eligible));
});
test('Low-confidence repositories are routed to manual review', async () => {
  const results = await classifyRepos(demoRepos.slice(0, 1), async () => ({ category_0: sampleAnswer(REPO_CATEGORIES, 'ai', 0.55), kind_0: sampleAnswer(REPO_KINDS, 'library') }));
  assert.equal(results[0]?.category, 'other'); assert.equal(results[0]?.review, true);
});
test('Feedback priority and category are independent questions, unknown priority requests review', async () => {
  const result = await classifyFeedback([{ id: '1', text: '有问题' }], async ({ questions }) => {
    assert.equal(Object.keys(questions).length, 2);
    return { category_0: sampleAnswer(questions.category_0!.criteria, 'bug'), priority_0: sampleAnswer(questions.priority_0!.criteria, 'review') };
  });
  assert.equal(result[0]?.review, true);
});
