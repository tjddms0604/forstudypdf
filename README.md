# ForStudyPdf

전공서 PDF를 보면서 원하는 위치에 메모를 남기면 AI가 추가 설명을 붙여주고, 메모 + AI 설명이 실제 PDF 주석으로 담긴 새 파일로 저장할 수 있는 학습 도구입니다.

## 주요 기능

**PDF 보기**
- 브라우저에서 바로 PDF를 열어봅니다. 파일은 서버로 전송되지 않고 브라우저에서만 처리됩니다.
- 1쪽 / 2쪽(스프레드) 보기 전환, 확대·축소(버튼 또는 `Ctrl` + 마우스 휠), 페이지 번호 입력으로 바로 이동, 접이식 메모 목록 사이드바.

**메모 남기기**
- PDF 위 원하는 위치를 클릭 → 텍스트 입력 → 저장하면 그 자리에 핀이 표시되고 AI 설명이 자동으로 요청됩니다.
- 텍스트 입력 중 `Enter` = 저장, `Shift+Enter` = 줄바꿈, `Esc` = 취소.
- 핀을 클릭하면 옆에 메모 + AI 설명이 뜨고, `Esc`나 × 로 닫을 수 있습니다.
- AI는 메모에 실제로 쓰인 언어(한국어/영어 등)에 맞춰 답합니다.

**기존 주석 불러오기**
- PDF 안에 이미 있는 주석(이 앱으로 저장한 것이든, 다른 PDF 도구로 남긴 것이든)을 열자마자 자동으로 인식해서 핀과 메모 목록에 표시합니다.
- AI 설명이 없는 주석은 "AI 설명 요청" 버튼으로 그때그때 채울 수 있습니다 (열자마자 전부 자동 요청하지는 않음 — API 사용량 보호).

**PDF로 저장**
- pdf-lib으로 원본 PDF에 실제 PDF 주석(스티키 노트)을 추가/수정/삭제해서 `원본이름_내주석_날짜.pdf`라는 새 파일로 내보냅니다.
- 손대지 않은 기존 주석은 원본 그대로 보존되고, 삭제한 주석은 저장된 파일에서 실제로 제거됩니다. 원본 파일 자체는 변경되지 않습니다.
- 저장하지 않은 변경사항이 있으면 탭을 닫거나 새로고침할 때 브라우저가 확인창을 띄웁니다.

**접근 제어**
- `.env`에 `SITE_PASSWORD`를 설정하면 로그인 게이트가 활성화됩니다 (배포 시 아무나 접속해서 AI 호출량을 소모하는 것을 막기 위함). 비워두면 로그인 없이 바로 사용합니다.

사용법은 [USER_GUIDE.md](USER_GUIDE.md)를 참고하세요.

## 기술 스택

- 프론트엔드: 순수 HTML/CSS/JS + [pdf.js](https://mozilla.github.io/pdf.js/)(렌더링·주석 읽기) + [pdf-lib](https://pdf-lib.js.org/)(PDF 주석 쓰기)
- 백엔드: Node.js + Express — 정적 파일 서빙, `/api/explain`(AI 설명 요청 프록시), `/api/login`(비밀번호 게이트)
- AI: [Groq API](https://groq.com/) (OpenAI 호환 엔드포인트, 기본 모델 `openai/gpt-oss-120b`)

## 로컬에서 실행하기

```bash
npm install
cp .env.example .env
```

`.env` 파일을 열어 값을 채워주세요:

```
GROQ_API_KEY=발급받은 Groq API 키
GROQ_MODEL=openai/gpt-oss-120b
PORT=5173
SITE_PASSWORD=원하는 비밀번호 (비워두면 로그인 없이 바로 사용)
```

```bash
npm run dev   # 파일 변경 시 자동 재시작 (nodemon)
# 또는
npm start     # 단순 실행
```

브라우저에서 `http://localhost:5173` 접속.

## 배포하기 (Render)

이 저장소에는 [render.yaml](render.yaml)이 포함되어 있어 [Render](https://render.com)에서 Blueprint로 한 번에 배포할 수 있습니다.

1. Render 대시보드 → **New +** → **Blueprint** → 이 저장소 선택
2. `GROQ_API_KEY`, `SITE_PASSWORD` 값 입력 (`.env`에 넣었던 값과 동일하게)
3. **Apply** → 배포 완료 후 `https://<서비스이름>.onrender.com`으로 접속

무료 플랜은 15분간 요청이 없으면 서버가 슬립 상태가 되고, 다음 접속 시 30~60초 정도 깨어나는 시간이 걸립니다. 이때 로그인 세션(서버 메모리에 저장됨)도 초기화되므로 비밀번호를 다시 입력해야 합니다.

## 프로젝트 구조

```
ForStudyPdf/
├─ server.js          # Express 서버: 정적 파일 서빙, /api/explain(AI 호출), /api/login(비밀번호 게이트)
├─ render.yaml        # Render Blueprint 설정
├─ public/
│  ├─ index.html      # 메인 페이지
│  ├─ login.html      # 비밀번호 입력 페이지
│  ├─ app.js          # 뷰어 / 메모 / AI 요청 / PDF 저장 로직
│  └─ style.css
├─ USER_GUIDE.md       # 실제 사용법 안내
└─ .env                # 로컬 전용 환경변수 (git에 올라가지 않음)
```

## 참고 / 주의사항

- `.env`는 `.gitignore`에 포함되어 있어 실제 API 키·비밀번호는 저장소에 올라가지 않습니다. 배포 플랫폼의 환경변수 설정에 직접 입력해야 합니다.
- PDF 내용 자체는 서버로 전송되지 않습니다. 서버로는 메모 텍스트만 전달되어 AI 설명 생성에 쓰입니다.
- 아주 큰 PDF(수백 페이지)는 여는 즉시 전체 페이지를 렌더링하기 때문에 초기 로딩이 다소 걸릴 수 있습니다.
