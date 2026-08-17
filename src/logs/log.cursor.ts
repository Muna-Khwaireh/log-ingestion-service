type CursorData = {
  timestamp: string;
  id: number;
};

export function encodeCursor(timestamp: Date, id: number): string {
  const data: CursorData = {
    timestamp: timestamp.toISOString(),
    id,
  };

  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeCursor(cursor: string): CursorData {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const data = JSON.parse(decoded) as CursorData;

    if (
      typeof data.timestamp !== "string" ||
      typeof data.id !== "number" ||
      !Number.isInteger(data.id)
    ) {
      throw new Error("invalid cursor");
    }

    const timestamp = new Date(data.timestamp);

    if (Number.isNaN(timestamp.getTime())) {
      throw new Error("invalid cursor");
    }

    return {
      timestamp: timestamp.toISOString(),
      id: data.id,
    };
  } catch {
    throw new Error("invalid cursor");
  }
}