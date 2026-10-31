// Envío de correo opcional (invitaciones). Si no hay correo configurado, la
// interfaz muestra el enlace de invitación para copiarlo y enviarlo a mano.
// Hoy se usa la API de Resend: MAIL_RESEND_API_KEY y MAIL_FROM en .env.
export function mailConfigured(): boolean {
  return Boolean(process.env.MAIL_RESEND_API_KEY && process.env.MAIL_FROM);
}

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MAIL_RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`[correo] Resend respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.warn('[correo]', (err as Error).message);
    return false;
  }
}
