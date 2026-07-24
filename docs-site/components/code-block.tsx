"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CodeBlock({
  code,
  language = "text",
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          type="button"
          className="icon-button"
          onClick={copyCode}
          aria-label="Copy code"
          title="Copy code"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
