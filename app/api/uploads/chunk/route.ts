import { put } from "@vercel/blob"
import { NextResponse } from "next/server"

import { auth } from "@/lib/auth"

export const runtime = "nodejs"

// Vercel rejects function request bodies over 4.5MB, so the client sends the
// file in slices below that and each one is stored as its own blob. Storing
// from the server uses the project's Blob store connection (OIDC), so no
// read-write token has to be configured.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

const UPLOAD_ID_PATTERN = /^[0-9a-f-]{36}$/

export async function POST(request: Request) {
  const session = await auth()
  if (session?.user.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const uploadId = searchParams.get("uploadId") ?? ""
  const index = Number(searchParams.get("index"))
  if (!UPLOAD_ID_PATTERN.test(uploadId) || !Number.isInteger(index) || index < 0 || index > 99_999) {
    return NextResponse.json({ error: "Invalid upload slice." }, { status: 400 })
  }

  const body = Buffer.from(await request.arrayBuffer())
  if (body.length === 0 || body.length > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: "Invalid upload slice size." }, { status: 400 })
  }

  try {
    const blob = await put(
      `uploads/${uploadId}/${String(index).padStart(5, "0")}.part`,
      body,
      {
        access: "public",
        contentType: "application/octet-stream",
        addRandomSuffix: true,
      }
    )
    return NextResponse.json({ url: blob.url })
  } catch (error) {
    console.error("[uploads] failed to store slice:", error)
    const message = error instanceof Error ? error.message : "Couldn't store the file."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
