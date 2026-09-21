export const metadata = {
  title: "Omie Consulta",
  description: "Conector MCP privado e somente leitura para o Omie"
};


export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
