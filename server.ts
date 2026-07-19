import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "dummy",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const CANNED_NARRATIVES = [
  "System stability degrading, chaos faults injected.",
  "Agents engaging mitigation protocols.",
  "Riders are stranded, ETA unknown.",
  "Surge multipliers failing, dispatch paused.",
  "Database connection dropped, standby spinning up.",
  "Stranded riders detected in sector 4.",
  "Memory threshold breached, purging cache.",
  "Duplicate dispatched detected, rolling back.",
  "System recovered, normal operations resuming.",
  "Manual intervention required, AI offline."
];

app.post("/api/narrate", async (req, res) => {
  try {
    const { events } = req.body;
    
    // Fallback if no key or >4s
    const geminiCall = ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Recent events:\n" + JSON.stringify(events),
      config: {
        systemInstruction: "You are a calm, dry-witted dispatch-room SRE commentator. One sentence, present tense, concrete numbers, no exclamation marks.",
      }
    });

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000));
    
    try {
      const response = await Promise.race([geminiCall, timeoutPromise]) as any;
      res.json({ text: response.text });
    } catch (err: any) {
      const randText = CANNED_NARRATIVES[Math.floor(Math.random() * CANNED_NARRATIVES.length)];
      res.json({ text: randText });
    }
  } catch (err) {
    const randText = CANNED_NARRATIVES[Math.floor(Math.random() * CANNED_NARRATIVES.length)];
    res.json({ text: randText });
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    const { query, events, activeFault } = req.body;
    
    const geminiCall = ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "User query: " + query + "\n\nContext:\nActive fault: " + (activeFault || "none") + "\nEvents: " + JSON.stringify(events),
      config: {
        systemInstruction: "You are a calm dispatch-room SRE. Answer from the provided events and active fault. 2 sentences max. Politely refuse questions outside incident data.",
      }
    });

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000));
    
    try {
      const response = await Promise.race([geminiCall, timeoutPromise]) as any;
      res.json({ text: response.text });
    } catch (err: any) {
      res.json({ text: "Unable to process query at this time." });
    }
  } catch (err) {
    res.json({ text: "Unable to process query at this time." });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
