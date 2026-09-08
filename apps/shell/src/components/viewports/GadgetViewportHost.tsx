import React, { useEffect, useRef, useState } from "react";

interface GadgetViewportHostProps {
  src: string;
  projectId: string;
  token: string;
  className?: string;
}

export function GadgetViewportHost({
  src,
  projectId,
  token,
  className = "",
}: GadgetViewportHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Build the final authenticated source URL
  // We append the gatekeeperToken via a secure URL hash/fragment to avoid exposing it in browser logs or referrer headers.
  const authenticatedSrc = React.useMemo(() => {
    try {
      const url = new URL(src);
      url.hash = `token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`;
      return url.toString();
    } catch (e) {
      // Fallback to simple string concatenation if src is a relative URL
      const separator = src.includes("#") ? "&" : "#";
      return `${src}${separator}token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`;
    }
  }, [src, token, projectId]);

  useEffect(() => {
    // Listen to messages from the iframe (Handshake / Protocol)
    const handleMessage = (event: MessageEvent) => {
      // Validate origin if possible. Since iframe might be 'null' origin in strict sandbox, 
      // we must handle messages carefully.
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "AVOS_GADGET_READY") {
        console.log(`[Viewport Host] Handshake received from Gadget inside Project: ${projectId}`);
        setIsLoaded(true);
        
        // Respond back to acknowledge handshake
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            {
              type: "AVOS_SHELL_ACK",
              projectId,
            },
            "*"
          );
        }
      }

      if (data.type === "AVOS_GADGET_ACTION") {
        console.log(`[Viewport Host] Action from Gadget:`, data.action);
        // Handle actions from gadget if needed (e.g. navigation, workspace events)
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [projectId]);

  return (
    <div className={`relative w-full h-full flex flex-col bg-slate-900 border border-slate-800 rounded-lg overflow-hidden ${className}`}>
      {/* Dynamic Header/Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-950 border-b border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isLoaded ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
            <span className={`relative inline-flex rounded-full h-2 w-2 ${isLoaded ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
          </span>
          <span className="font-mono text-slate-300">
            {src.replace(/^https?:\/\//, '').split('/')[0]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-semibold text-slate-400">
            Sandboxed Viewport
          </span>
        </div>
      </div>

      <div className="flex-1 relative bg-slate-950">
        {!isLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-3">
            <svg className="animate-spin h-6 w-6 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span className="text-sm font-medium">Resolving Viewport Connection...</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={authenticatedSrc}
          className={`w-full h-full border-0 transition-opacity duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
          sandbox="allow-scripts allow-forms allow-popups"
          loading="lazy"
          title={`Viewport Canvas for Project ${projectId}`}
        />
      </div>
    </div>
  );
}
