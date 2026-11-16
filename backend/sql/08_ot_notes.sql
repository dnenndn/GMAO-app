-- STEP 8 (notes and closing requests on work orders) - run in SSMS once.
-- Only touches the small GMAO_APP database. Nothing is added to GMAO_NGES.
USE GMAO_APP;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_ot_note')
BEGIN
    CREATE TABLE app_ot_note (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_ot INT NOT NULL,                 -- ordre_travail.id (GMAO_NGES)
        id_user INT NOT NULL,
        kind VARCHAR(10) NOT NULL,          -- 'note' | 'cloture' (closing requested)
        texte NVARCHAR(500) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_app_ot_note_ot ON app_ot_note (id_ot);
END;
GO
