// G-P-I18N: Multi-language UI — detect from navigator.language
// Supports: en, es, fr, de, ja, pt, zh

export interface Strings {
  connecting: string;
  unableToConnect: string;
  tryAgain: string;
  poweredBy: string;
  sendPlaceholder: string;
  sendButton: string;
  startConversation: string;
  aiDisclaimer: string;
  thumbsUp: string;
  thumbsDown: string;
  feedbackThanks: string;
  signIn: string;
  signInWithEmail: string;
  emailLabel: string;
  sendMagicLink: string;
  checkYourEmail: string;
  magicLinkSent: string;
  verifying: string;
  authSuccess: string;
  authError: string;
  dismiss: string;
  errorRetry: string;
}

const EN: Strings = {
  connecting: "Connecting to Space...",
  unableToConnect: "Unable to connect",
  tryAgain: "Try again",
  poweredBy: "Powered by Naelao",
  sendPlaceholder: "Type a message… (Enter to send, Shift+Enter for newline)",
  sendButton: "Send message",
  startConversation: "Send a message to start the conversation.",
  aiDisclaimer: "Responses are AI-generated and may not always be accurate.",
  thumbsUp: "Helpful",
  thumbsDown: "Not helpful",
  feedbackThanks: "Thanks for your feedback!",
  signIn: "Sign in",
  signInWithEmail: "Sign in with email",
  emailLabel: "Email address",
  sendMagicLink: "Send magic link",
  checkYourEmail: "Check your email",
  magicLinkSent: "We sent a sign-in link to",
  verifying: "Verifying...",
  authSuccess: "Signed in successfully!",
  authError: "This link is invalid or has expired.",
  dismiss: "Dismiss",
  errorRetry: "The agent encountered an error. Please try again.",
};

const ES: Strings = {
  connecting: "Conectando al espacio...",
  unableToConnect: "No se puede conectar",
  tryAgain: "Intentar de nuevo",
  poweredBy: "Con tecnología de Naelao",
  sendPlaceholder: "Escribe un mensaje… (Enter para enviar, Shift+Enter para nueva línea)",
  sendButton: "Enviar mensaje",
  startConversation: "Envía un mensaje para iniciar la conversación.",
  aiDisclaimer: "Las respuestas son generadas por IA y pueden no ser siempre precisas.",
  thumbsUp: "Útil",
  thumbsDown: "No útil",
  feedbackThanks: "¡Gracias por tu opinión!",
  signIn: "Iniciar sesión",
  signInWithEmail: "Iniciar sesión con correo",
  emailLabel: "Correo electrónico",
  sendMagicLink: "Enviar enlace mágico",
  checkYourEmail: "Revisa tu correo",
  magicLinkSent: "Enviamos un enlace de inicio de sesión a",
  verifying: "Verificando...",
  authSuccess: "¡Sesión iniciada con éxito!",
  authError: "Este enlace no es válido o ha expirado.",
  dismiss: "Cerrar",
  errorRetry: "El agente encontró un error. Por favor, inténtalo de nuevo.",
};

const FR: Strings = {
  connecting: "Connexion à l'espace...",
  unableToConnect: "Impossible de se connecter",
  tryAgain: "Réessayer",
  poweredBy: "Propulsé par Naelao",
  sendPlaceholder: "Tapez un message… (Entrée pour envoyer, Maj+Entrée pour nouvelle ligne)",
  sendButton: "Envoyer le message",
  startConversation: "Envoyez un message pour commencer la conversation.",
  aiDisclaimer: "Les réponses sont générées par IA et peuvent ne pas être toujours exactes.",
  thumbsUp: "Utile",
  thumbsDown: "Pas utile",
  feedbackThanks: "Merci pour votre retour !",
  signIn: "Se connecter",
  signInWithEmail: "Se connecter par e-mail",
  emailLabel: "Adresse e-mail",
  sendMagicLink: "Envoyer le lien magique",
  checkYourEmail: "Vérifiez votre e-mail",
  magicLinkSent: "Nous avons envoyé un lien de connexion à",
  verifying: "Vérification...",
  authSuccess: "Connexion réussie !",
  authError: "Ce lien est invalide ou a expiré.",
  dismiss: "Ignorer",
  errorRetry: "L'agent a rencontré une erreur. Veuillez réessayer.",
};

const DE: Strings = {
  connecting: "Verbindung zum Space...",
  unableToConnect: "Verbindung nicht möglich",
  tryAgain: "Erneut versuchen",
  poweredBy: "Bereitgestellt von Naelao",
  sendPlaceholder: "Nachricht eingeben… (Enter zum Senden, Shift+Enter für neue Zeile)",
  sendButton: "Nachricht senden",
  startConversation: "Sende eine Nachricht, um das Gespräch zu beginnen.",
  aiDisclaimer: "Antworten werden von KI generiert und sind möglicherweise nicht immer korrekt.",
  thumbsUp: "Hilfreich",
  thumbsDown: "Nicht hilfreich",
  feedbackThanks: "Danke für Ihr Feedback!",
  signIn: "Anmelden",
  signInWithEmail: "Mit E-Mail anmelden",
  emailLabel: "E-Mail-Adresse",
  sendMagicLink: "Magic Link senden",
  checkYourEmail: "Prüfen Sie Ihre E-Mail",
  magicLinkSent: "Wir haben einen Anmeldelink gesendet an",
  verifying: "Überprüfung...",
  authSuccess: "Erfolgreich angemeldet!",
  authError: "Dieser Link ist ungültig oder abgelaufen.",
  dismiss: "Schließen",
  errorRetry: "Der Agent hat einen Fehler festgestellt. Bitte versuchen Sie es erneut.",
};

const JA: Strings = {
  connecting: "スペースに接続中...",
  unableToConnect: "接続できません",
  tryAgain: "再試行",
  poweredBy: "Naelaoを使用",
  sendPlaceholder: "メッセージを入力… (Enter で送信、Shift+Enter で改行)",
  sendButton: "送信",
  startConversation: "メッセージを送って会話を始めましょう。",
  aiDisclaimer: "回答はAIによって生成されており、常に正確とは限りません。",
  thumbsUp: "役立った",
  thumbsDown: "役立たなかった",
  feedbackThanks: "フィードバックありがとうございます！",
  signIn: "サインイン",
  signInWithEmail: "メールでサインイン",
  emailLabel: "メールアドレス",
  sendMagicLink: "マジックリンクを送信",
  checkYourEmail: "メールを確認してください",
  magicLinkSent: "サインインリンクを送信しました：",
  verifying: "確認中...",
  authSuccess: "サインインしました！",
  authError: "このリンクは無効か期限切れです。",
  dismiss: "閉じる",
  errorRetry: "エラーが発生しました。もう一度お試しください。",
};

const PT: Strings = {
  connecting: "Conectando ao espaço...",
  unableToConnect: "Não foi possível conectar",
  tryAgain: "Tentar novamente",
  poweredBy: "Desenvolvido por Naelao",
  sendPlaceholder: "Digite uma mensagem… (Enter para enviar, Shift+Enter para nova linha)",
  sendButton: "Enviar mensagem",
  startConversation: "Envie uma mensagem para iniciar a conversa.",
  aiDisclaimer: "As respostas são geradas por IA e podem nem sempre ser precisas.",
  thumbsUp: "Útil",
  thumbsDown: "Não útil",
  feedbackThanks: "Obrigado pelo seu feedback!",
  signIn: "Entrar",
  signInWithEmail: "Entrar com e-mail",
  emailLabel: "Endereço de e-mail",
  sendMagicLink: "Enviar link mágico",
  checkYourEmail: "Verifique seu e-mail",
  magicLinkSent: "Enviamos um link de acesso para",
  verifying: "Verificando...",
  authSuccess: "Login realizado com sucesso!",
  authError: "Este link é inválido ou expirou.",
  dismiss: "Dispensar",
  errorRetry: "O agente encontrou um erro. Por favor, tente novamente.",
};

const ZH: Strings = {
  connecting: "正在连接到空间...",
  unableToConnect: "无法连接",
  tryAgain: "重试",
  poweredBy: "由 Naelao 提供支持",
  sendPlaceholder: "输入消息…（回车发送，Shift+回车换行）",
  sendButton: "发送消息",
  startConversation: "发送消息以开始对话。",
  aiDisclaimer: "回复由 AI 生成，可能并不总是准确的。",
  thumbsUp: "有帮助",
  thumbsDown: "没有帮助",
  feedbackThanks: "感谢您的反馈！",
  signIn: "登录",
  signInWithEmail: "使用电子邮件登录",
  emailLabel: "电子邮件地址",
  sendMagicLink: "发送魔法链接",
  checkYourEmail: "查看您的电子邮件",
  magicLinkSent: "我们已将登录链接发送至",
  verifying: "验证中...",
  authSuccess: "登录成功！",
  authError: "此链接无效或已过期。",
  dismiss: "关闭",
  errorRetry: "代理遇到错误，请重试。",
};

const LOCALE_MAP: Record<string, Strings> = {
  en: EN, es: ES, fr: FR, de: DE, ja: JA, pt: PT, zh: ZH,
};

export function getStrings(): Strings {
  if (typeof navigator === "undefined") return EN;
  const lang = navigator.language?.split("-")[0]?.toLowerCase() ?? "en";
  return LOCALE_MAP[lang] ?? EN;
}
