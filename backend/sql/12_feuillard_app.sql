-- STEP 12 (strapping module: entering movements from the phone) - run in SSMS once. Only touches GMAO_APP.
-- Nothing is added to the "feuillard" database.
USE GMAO_APP;
GO
-- Which user of the strapping desktop application ("feuillard".dbo.utilisateur) an app user is.
-- The desktop records that id on every receipt / issue / return (id_magasinier). If no link exists the app
-- looks for a strapping user with the same name as the app login.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_feuillard_user')
BEGIN
    CREATE TABLE app_feuillard_user (
        desktop_id        INT NOT NULL,     -- app_user.desktop_id (GMAO)
        id_feuillard_user INT NOT NULL,     -- feuillard.dbo.utilisateur.id
        CONSTRAINT PK_app_feuillard_user PRIMARY KEY (desktop_id)
    );
END;
GO
-- Who entered what from the phone (the strapping tables themselves do not say, for production records).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_feuillard_log')
BEGIN
    CREATE TABLE app_feuillard_log (
        id         INT IDENTITY PRIMARY KEY,
        kind       VARCHAR(30)   NOT NULL,   -- entree | sortie | retour | retour_fournisseur | production
        ref_id     INT           NULL,       -- id of the row created in the strapping database
        id_user    INT           NULL,       -- app_user.desktop_id
        login      NVARCHAR(100) NULL,
        summary    NVARCHAR(300) NULL,
        created_at DATETIME      NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_app_feuillard_log_date ON app_feuillard_log (created_at);
END;
GO
