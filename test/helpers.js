export function req(headers = {}) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (key) => lowered[key.toLowerCase()] || null } };
}

export function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
  });
}

export async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

export function parseSSE(raw) {
  const events = [];
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let event = null;
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (event) {
      const text = data.join("\n");
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* leave text */ }
      events.push({ event, data: parsed });
    }
  }
  return events;
}

export const openAIData = (data) => `data: ${JSON.stringify(data)}\n\n`;
