# NexusClin

AI-assisted clinical trial eligibility matching for Zephoria 2K26 PS-02.

## Demo flow
1. Upload a clinical trial protocol PDF.
2. Enter a synthetic patient medical summary.
3. Analyze eligibility.
4. Show score, PASS/FAIL criteria, exact evidence and page.
5. Saved analyses appear in the cohort table.

## Environment
Copy `.env.example` to `.env.local`:

- `GEMINI_API_KEY` — server-side only.
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Run:

```bash
npm install
npm run dev
```

For Supabase, run `supabase/schema.sql` in the SQL editor.

## Security
Never place the Gemini secret in client-side code. The AI call happens in the Next.js server route.
