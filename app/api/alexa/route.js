import { SkillRequestSignatureVerifier, TimestampVerifier } from "ask-sdk-express-adapter";
import { handleAlexaEnvelope, validateAlexaApplication } from "../../../lib/jarvis.js";


export const runtime = "nodejs";
export const maxDuration = 60;


const signatureVerifier = new SkillRequestSignatureVerifier();
const timestampVerifier = new TimestampVerifier();


export async function POST(request) {
  const body = await request.text();
  const headers = Object.fromEntries(request.headers.entries());


  try {
    await signatureVerifier.verify(body, headers);
    await timestampVerifier.verify(body);
  } catch {
    return Response.json({ error: "Requisição Alexa inválida." }, { status: 401 });
  }


  try {
    const envelope = JSON.parse(body);
    validateAlexaApplication(envelope);
    const result = await handleAlexaEnvelope(envelope);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Jarvis Alexa error:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Jarvis não conseguiu processar a consulta." }, { status: 500 });
  }
}


export function GET() {
  return Response.json({
    status: "ok",
    service: "jarvis-alexa",
    mode: "read_only",
    configured: Boolean(process.env.ALEXA_SKILL_ID),
    signature_verification: true,
    pin_required: false
  });
}
