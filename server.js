import express from "express";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// In-memory Bullhorn session (MVP)
const bullhorn = {
  accessToken: null,
  refreshToken: null,
  restUrl: null,
  bhRestToken: null,
  lastLoginAt: 0
};

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// OpenAI Realtime: ephemeral session token (Aria voice, Molly persona)
// OpenAI Realtime: ephemeral session token (Aria voice, Molly persona)
const handleEphemeralSession = async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "aria",
        instructions: [
          "You are Molly, Wave’s recruiting assistant.",
          "Speak British English with a natural London accent; sound like a friendly 30-year-old woman.",
          "Be concise, warm, and practical. No corporate jargon.",
          "Confirm must-have skills, location, and comp band before searching.",
          "When you need to search Bullhorn, output exactly one line of the form:",
          "@@SEARCH {\"job_title\":\"...\",\"skills\":[\"...\"],\"location\":\"...\",\"seniority\":\"junior|mid|senior|lead\",\"top_n\":5}",
          "After outputting that line, wait for results before continuing."
        ].join(" ")
      })
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Ephemeral key error:", r.status, data);
      return res.status(r.status).json(data);
    }

    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

// Keep both so either path works
app.post("/api/voice-token", handleEphemeralSession);
app.get("/session", handleEphemeralSession);
app.post("/session", handleEphemeralSession);
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "Failed to create session", details: data });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Bullhorn OAuth start
app.get("/api/bullhorn/oauth/start", (_req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.BULLHORN_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.BULLHORN_REDIRECT_URI,
  });
  res.redirect(`https://auth.bullhornstaffing.com/oauth/authorize?${params.toString()}`);
});

// Bullhorn OAuth callback
app.get("/api/bullhorn/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      client_id: process.env.BULLHORN_CLIENT_ID,
      client_secret: process.env.BULLHORN_CLIENT_SECRET,
      redirect_uri: process.env.BULLHORN_REDIRECT_URI,
    });

    const tokenResp = await fetch("https://auth.bullhornstaffing.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("Bullhorn token error:", tokenJson);
      return res.status(500).send("Bullhorn token exchange failed");
    }

    bullhorn.accessToken = tokenJson.access_token;
    bullhorn.refreshToken = tokenJson.refresh_token;

    const loginUrl = `https://rest.bullhornstaffing.com/rest-services/login?version=2.0&access_token=${encodeURIComponent(bullhorn.accessToken)}`;
    const loginResp = await fetch(loginUrl);
    const loginJson = await loginResp.json();
    if (!loginResp.ok || !loginJson.BhRestToken || !loginJson.restUrl) {
      console.error("Bullhorn login error:", loginJson);
      return res.status(500).send("Bullhorn login failed");
    }

    bullhorn.bhRestToken = loginJson.BhRestToken;
    bullhorn.restUrl = loginJson.restUrl;
    bullhorn.lastLoginAt = Date.now();

    res.redirect("/?bullhorn=connected");
  } catch (e) {
    console.error(e);
    res.status(500).send("Bullhorn callback error");
  }
});

app.get("/api/bullhorn/status", (_req, res) => {
  res.json({ connected: Boolean(bullhorn.bhRestToken && bullhorn.restUrl) });
});

async function ensureBullhornLogin() {
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;
  if (!bullhorn.accessToken || !bullhorn.restUrl || !bullhorn.bhRestToken) return false;
  if (Date.now() - bullhorn.lastLoginAt < EIGHT_HOURS) return true;

  const loginUrl = `https://rest.bullhornstaffing.com/rest-services/login?version=2.0&access_token=${encodeURIComponent(bullhorn.accessToken)}`;
  const loginResp = await fetch(loginUrl);
  if (!loginResp.ok) return false;
  const loginJson = await loginResp.json();
  if (!loginJson.BhRestToken || !loginJson.restUrl) return false;

  bullhorn.bhRestToken = loginJson.BhRestToken;
  bullhorn.restUrl = loginJson.restUrl;
  bullhorn.lastLoginAt = Date.now();
  return true;
}

// Bullhorn Candidate search
app.post("/api/search-candidates", async (req, res) => {
  try {
    const { job_title, skills = [], location = "", seniority = "", top_n = 5 } = req.body || {};
    if (!bullhorn.bhRestToken || !bullhorn.restUrl) return res.status(400).json({ error: "Bullhorn not connected" });
    await ensureBullhornLogin();

    const parts = [];
    if (job_title) parts.push(`title:"${job_title}"`);
    if (skills.length) parts.push("(" + skills.map(s => `skills:"${s}"`).join(" OR ") + ")");
    if (location) parts.push(`address.city:"${location}"`);
    if (seniority) parts.push(`employmentPreference:"${seniority}"`);
    parts.push("isDeleted:false");

    const query = parts.join(" AND ");
    const params = new URLSearchParams({
      query,
      count: String(Math.max(1, Math.min(20, top_n))),
      start: "0",
      fields: "id,firstName,lastName,name,address(city,state),employmentPreference,skills,dateLastModified"
    });

    const url = `${bullhorn.restUrl}search/Candidate?${params.toString()}`;
    const resp = await fetch(url, { headers: { BhRestToken: bullhorn.bhRestToken } });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Bullhorn search error:", data);
      return res.status(500).json({ error: "Bullhorn search failed", details: data });
    }

    const results = (data?.data || []).map(c => ({
      id: c.id,
      name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      city: c?.address?.city || null,
      state: c?.address?.state || null,
      employmentPreference: c?.employmentPreference || null,
      skills: c?.skills || null,
      lastUpdated: c?.dateLastModified || null
    }));

    res.json({ query, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// TTS preview (Aria/Verse)
app.post("/api/tts", async (req, res) => {
  try {
    const { voice = "aria", text = "Hello! I’m Molly from Wave." } = req.body || {};
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        format: "mp3"
      })
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(500).send(err);
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.status(500).send("TTS error");
  }
});

// Inline HTML pages (no public folder needed)
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Wave-Molly Voice Agent</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
      button { padding: 0.6rem 1rem; font-size: 1rem; margin-right: 0.5rem; }
      .log { margin-top: 1rem; padding: 1rem; background: #f7f7f8; border-radius: 8px; height: 220px; overflow: auto; }
      .row { margin: 0.25rem 0; white-space: pre-wrap; }
      .user { color: #0b5fff; }
      .agent { color: #1a7f37; }
      .warn { color: #b54708; }
      .badge { display: inline-block; padding: 0.2rem 0.5rem; background: #e6f4ea; color: #1a7f37; border-radius: 12px; font-size: 0.85rem; }
      .section { margin-top: 1rem; }
      input[type=text] { padding: 0.5rem; width: 220px; }
    </style>
  </head>
  <body>
    <h1>Talk to Molly</h1>

    <div class="section">
      <button id="startBtn">Start</button>
      <button id="stopBtn" disabled>Stop</button>
      <span id="bhStatus" class="badge">Bullhorn: checking…</span>
      <button id="bhConnectBtn">Connect Bullhorn</button>
    </div>

    <div class="section">
      <strong>Manual test (optional):</strong>
      <input id="jobTitle" type="text" placeholder="Job title e.g. SRE" />
      <input id="skills" type="text" placeholder="Skills (comma-separated)" />
      <input id="location" type="text" placeholder="Location e.g. London" />
      <select id="seniority">
        <option value="">Any seniority</option>
        <option>junior</option>
        <option>mid</option>
        <option>senior</option>
        <option>lead</option>
      </select>
      <button id="testSearchBtn">Test candidate search</button>
    </div>

    <div class="log" id="log"></div>

    <script>
      const logEl = document.getElementById("log");
      function log(text, cls = "") {
        const row = document.createElement("div");
        row.className = "row " + cls;
        row.textContent = text;
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
      }

      let pc, dc, micStream;
      let textBuffer = "";

      async function refreshBhStatus() {
        const r = await fetch("/api/bullhorn/status");
        const j = await r.json();
        const el = document.getElementById("bhStatus");
        el.textContent = j.connected ? "Bullhorn: connected" : "Bullhorn: not connected";
        el.style.background = j.connected ? "#e6f4ea" : "#fde7e9";
        el.style.color = j.connected ? "#1a7f37" : "#b42318";
      }

      async function start() {
        document.getElementById("startBtn").disabled = true;
        document.getElementById("stopBtn").disabled = false;

        const tokenResp = await fetch("/api/voice-token", { method: "POST" });
        const tokenJson = await tokenResp.json();
        const EPHEMERAL_KEY = tokenJson?.client_secret?.value;
        if (!EPHEMERAL_KEY) { log("Failed to get ephemeral key", "warn"); return; }

        pc = new RTCPeerConnection();
        const audioEl = new Audio(); audioEl.autoplay = true;
        pc.ontrack = (event) => { audioEl.srcObject = event.streams[0]; };

        dc = pc.createDataChannel("oai-events");
        dc.onopen = () => {
          log("Connected. Start speaking…", "agent");
          sendResponseCreate("Say a brief hello and ask what role I'm hiring for.");
        };
        dc.onmessage = async (e) => {
          try {
            const evt = JSON.parse(e.data);
            if (evt.type === "response.text.delta" && typeof evt.delta === "string") {
              textBuffer += evt.delta;
              const lines = textBuffer.split(/\\n/);
              if (lines.length > 1) {
                for (let i = 0; i < lines.length - 1; i++) {
                  const line = lines[i].trim();
                  if (line.startsWith("@@SEARCH ")) {
                    const jsonPart = line.slice(9).trim();
                    try {
                      const args = JSON.parse(jsonPart);
                      log("Agent requested Bullhorn search: " + JSON.stringify(args), "agent");
                      const results = await doBullhornSearch(args);
                      sendResponseCreate(
                        "Summarise these candidates for the user in a friendly, succinct way and propose next steps. " +
                        "Do not read IDs aloud; use first names only.\\n\\nResults JSON:\\n" +
                        JSON.stringify(results)
                      );
                    } catch (err) {
                      log("Failed to parse @@SEARCH JSON: " + err.message, "warn");
                    }
                  } else {
                    if (line) log(line, "agent");
                  }
                }
                textBuffer = lines[lines.length - 1];
              }
            }
          } catch {}
        };

        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const baseUrl = "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
        const sdpResp = await fetch(baseUrl, {
          method: "POST",
          headers: { Authorization: \`Bearer \${EPHEMERAL_KEY}\`, "Content-Type": "application/sdp" },
          body: offer.sdp,
        });
        const answer = { type: "answer", sdp: await sdpResp.text() };
        await pc.setRemoteDescription(answer);
      }

      function stop() {
        document.getElementById("startBtn").disabled = false;
        document.getElementById("stopBtn").disabled = true;
        if (dc && dc.readyState === "open") dc.close();
        if (pc) pc.close();
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        textBuffer = "";
        log("Stopped", "agent");
      }

      function sendResponseCreate(instructions) {
        if (!dc || dc.readyState !== "open") return;
        dc.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"], instructions } }));
      }

      async function doBullhornSearch(args) {
        const r = await fetch("/api/search-candidates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args)
        });
        const j = await r.json();
        if (!r.ok) { log("Bullhorn search failed: " + (j?.error || "unknown"), "warn"); return { query: "", results: [] }; }
        return j;
      }

      document.getElementById("startBtn").addEventListener("click", start);
      document.getElementById("stopBtn").addEventListener("click", stop);
      document.getElementById("testSearchBtn").addEventListener("click", async () => {
        const job_title = document.getElementById("jobTitle").value.trim();
        const skills = document.getElementById("skills").value.split(",").map(s => s.trim()).filter(Boolean);
        const location = document.getElementById("location").value.trim();
        const seniority = document.getElementById("seniority").value;
        const payload = { job_title, skills, location, seniority, top_n: 5 };
        log("Manual Bullhorn search: " + JSON.stringify(payload), "user");
        const results = await doBullhornSearch(payload);
        log("Results: " + JSON.stringify(results, null, 2), "agent");
        sendResponseCreate("Summarise these candidates for the user:\\n" + JSON.stringify(results));
      });
      document.getElementById("bhConnectBtn").addEventListener("click", () => {
        window.location.href = "/api/bullhorn/oauth/start";
      });

      refreshBhStatus();
    </script>
  </body>
</html>`);
});

app.get("/voices.html", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Wave-Molly Voice Previews</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    button { padding: 0.6rem 1rem; font-size: 1rem; margin-right: 0.5rem; margin-top: 0.5rem; }
    .note { color: #475467; font-size: 0.95rem; }
  </style>
</head>
<body>
  <h1>Voice Previews</h1>
  <p class="note">Click a button to hear a short sample. If a builder blocks audio in preview, open the live URL.</p>
  <button onclick="play('aria')">Play Aria (friendly British)</button>
  <button onclick="play('verse')">Play Verse (natural, warm)</button>
  <script>
    async function play(voice) {
      const text = "Hiya! I’m Molly from Wave. I’ll help you find brilliant candidates in London. What role are you hiring for?";
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice, text }) });
      if (!r.ok) return alert("TTS failed");
      const blob = await r.blob(); const url = URL.createObjectURL(blob); new Audio(url).play();
    }
  </script>
</body>
</html>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Wave-Molly running at http://localhost:${port}`);
});
