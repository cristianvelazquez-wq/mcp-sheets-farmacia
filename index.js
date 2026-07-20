import express from "express";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Autenticación con Google Sheets
let doc;
try {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
} catch (e) {
  console.error("Error al cargar credenciales:", e);
}

// Definición de las herramientas
const TOOLS_DEFINITION = [
  {
    name: "consultar_producto",
    description: "Busca productos en la farmacia por nombre, descripción, SKU o código de barras en tiempo real.",
    inputSchema: {
      type: "object",
      properties: {
        busqueda: { type: "string", description: "Nombre, SKU o código de barras del producto" }
      },
      required: ["busqueda"]
    }
  }
];

// Función de búsqueda
async function buscarEnSheets(query) {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  const q = (query || '').toLowerCase();

  const resultados = rows.filter(row => {
    const descrip = (row.get('descrip') || '').toLowerCase();
    const sku = (row.get('sku') || '').toString().toLowerCase();
    const barras = (row.get('barras') || '').toString().toLowerCase();
    return descrip.includes(q) || sku.includes(q) || barras.includes(q);
  }).map(row => ({
    sku: row.get('sku'),
    barras: row.get('barras'),
    descripcion: row.get('descrip'),
    precio: row.get('precio'),
    stock: row.get('stock')
  }));

  return resultados.slice(0, 5);
}

// Endpoint compatible con el descubrimiento de Botmaker (GET)
app.get(["/", "/sse", "/mcp"], (req, res) => {
  res.json({
    jsonrpc: "2.0",
    result: {
      tools: TOOLS_DEFINITION
    }
  });
});

// Endpoint compatible con ejecución de MCP (POST)
app.post(["/", "/sse", "/messages", "/mcp"], async (req, res) => {
  const { method, params, id } = req.body || {};

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id: id || 1,
      result: { tools: TOOLS_DEFINITION }
    });
  }

  if (method === "tools/call") {
    try {
      const busqueda = params?.arguments?.busqueda || "";
      const datos = await buscarEnSheets(busqueda);
      return res.json({
        jsonrpc: "2.0",
        id: id || 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(datos) }]
        }
      });
    } catch (err) {
      return res.json({
        jsonrpc: "2.0",
        id: id || 1,
        error: { code: -32603, message: err.message }
      });
    }
  }

  // Respuesta por defecto para Handshake/Init
  res.json({
    jsonrpc: "2.0",
    id: id || 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-sheets-farmacia", version: "1.0.0" }
    }
  });
});

app.listen(PORT, () => console.log(`Servidor MCP listo en puerto ${PORT}`));
