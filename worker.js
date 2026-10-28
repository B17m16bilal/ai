// ===== Astra B - Cloudflare Worker =====
// المفاتيح تُقرأ من المتغير السري GROQ_KEYS (مفتاح في كل سطر) ولا تظهر للزوار أبدًا.

const ALLOWED_ORIGIN = "https://b17m16bilal.github.io";

const PERSONALITY =
  "أنت Astra B، مساعد ذكاء اصطناعي صممه المطور مريان بلال. " +
  "شخصيتك واضحة وذكية وهادئة ودودة، تعرف متى تختصر ومتى تتوسع. " +
  "عندما يسألك أحد من أنت أو من صنعك، أجب بأنك Astra B وأن مصممك هو المطور مريان بلال.";

const BASE_RULES = [
  "أجب بلغة المستخدم: العربية الفصحى أو اللهجة، وبالفرنسية أو الإنجليزية إذا كتب بها أو طلبها.",
  "إذا كان السؤال غامضًا، اطلب توضيحًا قصيرًا أو اقترح صياغة أوضح قبل الإجابة.",
  "إذا كانت المعلومة حديثة أو حساسة للدقة، وضّح درجة يقينك وما يحتاج إلى تحقق، ولا تقدّم التخمين كحقيقة.",
  "إذا طلب المستخدم تنفيذ مهمة، رتّب الإجابة كخطوات مرقمة واضحة.",
];

const MODE_RULES = {
  short: "أجب باختصار شديد.",
  detailed: "أجب بتفصيل ومنهجية منظمة.",
  professional: "استخدم أسلوبًا مهنيًا رسميًا.",
  simple: "بسّط الشرح لشخص مبتدئ.",
  tutor:
    "أنت معلّم: اشرح المفهوم بأمثلة، ثم اختم بسؤال قصير للتأكد من الفهم، " +
    "ولا تعطِ الحل النهائي مباشرة إن كان المستخدم يتعلم.",
};

const TASK_PROMPTS = {
  summarize: "لخّص المحادثة التالية في نقاط قصيرة واضحة بالعربية.",
  improve:
    "حسّن النص التالي: صحح الأخطاء وحسّن الصياغة. أعد النص المحسّن فقط دون أي شرح.",
  followups:
    "اقترح ثلاثة أسئلة متابعة مرتبطة بآخر رد في المحادثة. " +
    "أعد مصفوفة JSON فقط من ثلاثة نصوص عربية، بدون أي نص آخر أو علامات markdown.",
};

const CACHE_MS = 10 * 60 * 1000;
const modelCache = { list: null, at: 0 };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function buildSystem(mode, task) {
  if (task && TASK_PROMPTS[task]) return TASK_PROMPTS[task];
  const parts = [PERSONALITY, ...BASE_RULES];
  if (MODE_RULES[mode]) parts.push(MODE_RULES[mode]);
  return parts.join(" ");
}

// يجلب النماذج المتاحة لحسابك ويخزنها مؤقتًا، ويستبعد نماذج الصوت والحماية
async function getModels(key) {
  if (modelCache.list && Date.now() - modelCache.at < CACHE_MS) return modelCache.list;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
    const data = await res.json();
    const list = (data.data || [])
      .map((m) => m.id)
      .filter((id) => !/whisper|tts|guard|embed|orpheus|prompt/i.test(id))
      .slice(0, 6);
    if (list.length) {
      modelCache.list = list;
      modelCache.at = Date.now();
      return list;
    }
  } catch {}
  return [];
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "الطريقة غير مسموحة" }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "طلب غير صالح" }, 400, origin);
    }

    const task = TASK_PROMPTS[body.task] ? body.task : null;
    const mode = MODE_RULES[body.mode] ? body.mode : "default";

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-30)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text.slice(0, 12000) }));

    if (!messages.length) {
      return json({ error: "لا توجد رسالة" }, 400, origin);
    }

    const keys = (env.GROQ_KEYS || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (!keys.length) {
      return json({ error: "الخدمة غير مهيأة بعد" }, 500, origin);
    }

    const payload = [{ role: "system", content: buildSystem(mode, task) }, ...messages];
    const temperature = task === "improve" || task === "followups" ? 0.3 : 0.7;

    let lastError = "";
    for (const key of keys) {
      const models = await getModels(key);
      for (const model of models) {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          body: JSON.stringify({ model, messages: payload, temperature }),
        });

        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch {}

        if (res.ok) {
          const reply = (data?.choices?.[0]?.message?.content || "").trim();
          return json({ reply }, 200, origin);
        }

        lastError = data?.error?.message || `رمز ${res.status}`;
        // 401/403: المفتاح غير صالح، و429: وصل المفتاح للحد. ننتقل للمفتاح التالي
        if ([401, 403, 429].includes(res.status)) break;
      }
    }

    if (!lastError) lastError = "لا توجد نماذج متاحة لهذا المفتاح";
    return json({ error: "تعذّر الرد: " + lastError }, 502, origin);
  },
};
