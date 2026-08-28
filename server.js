require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5173;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const SITE_PASSWORD = process.env.SITE_PASSWORD;

const SESSION_COOKIE = 'fspdf_session';
const activeSessions = new Set();

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies[SESSION_COOKIE] && activeSessions.has(cookies[SESSION_COOKIE]));
}

app.use(express.json({ limit: '2mb' }));

app.post('/api/login', (req, res) => {
  if (!SITE_PASSWORD) {
    return res.status(400).json({ error: '서버에 SITE_PASSWORD가 설정되어 있지 않습니다.' });
  }
  const { password } = req.body || {};
  if (password !== SITE_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  activeSessions.add(token);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`
  );
  res.json({ ok: true });
});

// Password gate: only enforced when SITE_PASSWORD is set, so local dev without
// a password configured keeps working exactly as before.
app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next();
  if (req.path === '/login.html') return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/explain', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        error: '서버에 GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 만들고 키를 입력한 뒤 서버를 다시 시작하세요.',
      });
    }

    const { memo } = req.body || {};
    if (!memo) {
      return res.status(400).json({ error: 'memo가 필요합니다.' });
    }

    // Decide the reply language ourselves rather than trusting the model to infer
    // "same language as the memo" — with a Korean-heavy prompt template, smaller
    // models tend to default to Korean regardless of the memo's actual language.
    const isKorean = /[가-힣]/.test(memo);
    const replyLanguage = isKorean ? 'Korean' : 'the same language the memo is written in (do NOT use Korean)';

    const prompt = `You are a tutor helping a student study from a textbook PDF. The student marked a specific spot in the PDF and left the memo below. The original passage itself isn't available as text (e.g. the page may be scanned), so do your best using only the memo.

Student's memo:
"""
${memo}
"""

Instructions:
- Write your reply in ${replyLanguage}. This is mandatory.
- Address the concept, question, or misunderstanding implied by the memo — don't just restate it.
- If the memo is short or vague, briefly add generally relevant background knowledge.
- Keep it concise: about 3-6 sentences.
- Plain text only, no markdown symbols (*, #, -, etc).

Reminder: your entire reply must be written in ${replyLanguage}.`;

    // openai/gpt-oss models occasionally spend their whole token budget on hidden
    // "reasoning" and return empty content — this is intermittent, so retry a
    // couple of times rather than surfacing a blank explanation to the student.
    let explanation = '';
    let lastErrorStatus = null;
    for (let attempt = 0; attempt < 3 && !explanation; attempt++) {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 800,
          temperature: 0.3,
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Groq API error:', response.status, errText);
        lastErrorStatus = response.status;
        continue;
      }

      const data = await response.json();
      explanation = (data.choices?.[0]?.message?.content || '').trim();
    }

    if (!explanation) {
      return res.status(502).json({
        error: lastErrorStatus
          ? `AI 호출에 실패했습니다 (status ${lastErrorStatus})`
          : 'AI가 빈 응답을 반환했습니다. 다시 시도해주세요.',
      });
    }

    res.json({ explanation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ForStudyPdf server running at http://localhost:${PORT}`);
});
