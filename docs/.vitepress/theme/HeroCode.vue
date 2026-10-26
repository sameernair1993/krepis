<script setup lang="ts">
// A static, hand-highlighted example for the home page hero. The behaviour it shows is covered by the
// package's tests (`enum.test.ts` for the type error, `safety.test.ts` for hidden fields).
type Token = [kind: string, text: string];

const lines: Token[][] = [
  [['kw', 'import'], ['p', ' { createDal, schema, t } '], ['kw', 'from'], ['s', " '@sameernair/krepis'"], ['p', ';']],
  [],
  [['kw', 'const'], ['p', ' dal = '], ['f', 'createDal'], ['p', '(client, { dbName: '], ['s', "'app'"], ['p', ' });']],
  [['kw', 'const'], ['p', ' Users = dal.'], ['f', 'collection'], ['p', '('], ['s', "'users'"], ['p', ', '], ['f', 'schema'], ['p', '({']],
  [['p', '  email: t.'], ['f', 'string'], ['p', '().'], ['f', 'lowercase'], ['p', '(),']],
  [['p', '  passwordHash: t.'], ['f', 'string'], ['p', '().'], ['f', 'hidden'], ['p', '(),']],
  [['p', '  plan: t.'], ['f', 'enum'], ['p', '(['], ['s', "'free'"], ['p', ', '], ['s', "'pro'"], ['p', ']),']],
  [['p', '}));']],
  [],
  [['kw', 'const'], ['p', ' user = '], ['kw', 'await'], ['p', ' Users.'], ['f', 'findOne'], ['p', '({ plan: '], ['s', "'pro'"], ['p', ' });']],
  [['c', '// passwordHash is left out unless selected']],
  [],
  [['kw', 'await'], ['p', ' Users.'], ['f', 'findOne'], ['p', '({ plan: '], ['e', "'gold'"], ['p', ' });']],
  [['c', "// type error: not 'free' | 'pro'"]],
];
</script>

<template>
  <figure class="kr-code" aria-label="Example: a typed Krepis collection">
    <div class="kr-code__bar">
      <span class="kr-code__dot" />
      <span class="kr-code__dot" />
      <span class="kr-code__dot" />
      <span class="kr-code__file">users.ts</span>
    </div>
    <pre class="kr-code__body"><code><span v-for="(line, i) in lines" :key="i" class="kr-code__line"><span v-for="([kind, text], j) in line" :key="j" :class="`t-${kind}`">{{ text }}</span></span></code></pre>
  </figure>
</template>

<style scoped>
.kr-code {
  position: relative;
  margin: 0;
  width: 100%;
  max-width: 520px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  background: #0b1220;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 24px 48px -16px rgba(2, 6, 23, 0.45);
  overflow: hidden;
}

.kr-code__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(148, 163, 184, 0.06);
}

.kr-code__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(148, 163, 184, 0.35);
}

.kr-code__file {
  margin-left: 10px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: #94a3b8;
}

.kr-code__body {
  margin: 0;
  padding: 16px 18px 18px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.7;
  color: #e2e8f0;
  background: transparent;
}

.kr-code__line {
  display: block;
  min-height: 1.7em;
  white-space: pre;
}

.t-kw { color: #c4b5fd; }
.t-f { color: #7dd3fc; }
.t-s { color: #86efac; }
.t-c { color: #64748b; font-style: italic; }
.t-p { color: #e2e8f0; }
.t-e {
  color: #86efac;
  text-decoration: underline wavy #f87171;
  text-decoration-skip-ink: none;
  text-underline-offset: 4px;
}
</style>
