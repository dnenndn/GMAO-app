USE GMAO_APP;
GO
-- Fuel tank checks: somebody measures the litres really in the tank and the app records it next to the
-- stock the desktop software believes (app-only table, nothing added to GMAO_NGES).
IF OBJECT_ID('dbo.app_cuve_controle') IS NULL
CREATE TABLE dbo.app_cuve_controle (
  id              int IDENTITY(1,1) PRIMARY KEY,
  id_article      int           NOT NULL,   -- the fuel article (article.id in GMAO_NGES)
  date_controle   date          NOT NULL,
  litres_mesures  float         NOT NULL,
  stock_theorique float         NULL,       -- article.stock_neuf at the time of the check
  note            nvarchar(200) NULL,
  id_user         int           NULL,
  created_at      datetime      NOT NULL DEFAULT GETDATE()
);
CREATE INDEX ix_cuve_article ON dbo.app_cuve_controle (id_article, date_controle);
GO
