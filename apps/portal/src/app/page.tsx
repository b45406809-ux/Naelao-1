// Root page — shown when no spaceId is provided in the URL.
// Directs users to use /{spaceId} to access a specific Space.

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full text-center">
        <div className="mb-6">
          <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-indigo-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-3-3z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Naelao Spaces</h1>
          <p className="mt-2 text-gray-500 text-sm">
            Space not found — use{" "}
            <code className="bg-gray-100 text-indigo-700 px-1.5 py-0.5 rounded font-mono text-xs">
              /{"{spaceId}"}
            </code>{" "}
            to access a space.
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 text-left">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Example
          </p>
          <p className="font-mono text-sm text-gray-700 break-all">
            https://portal.naelao.com/
            <span className="text-indigo-600">space_abc123</span>
          </p>
        </div>
      </div>
    </main>
  );
}
