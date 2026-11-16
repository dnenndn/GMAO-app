USE GMAO_APP;
GO
-- Per-engine fuel alert threshold (app-only table, nothing added to GMAO_NGES).
-- ratio: alert when an issue exceeds ratio x the engine's usual (NULL = global default, 1.5).
-- actif: 0 = no fuel alerts for this engine.
IF OBJECT_ID('dbo.app_engin_seuil') IS NULL
CREATE TABLE dbo.app_engin_seuil (
  id_engin   int        NOT NULL PRIMARY KEY,
  ratio      float      NULL,
  actif      bit        NOT NULL DEFAULT 1,
  updated_by int        NULL,
  updated_at datetime   NOT NULL DEFAULT GETDATE()
);
GO
