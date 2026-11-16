-- STEP 7 (per-user feature permissions) - run in SSMS once.
-- Only touches the small GMAO_APP database. Nothing is added to GMAO_NGES.
-- A row = an exception to the role's default for one user and one feature.
USE GMAO_APP;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_user_permission')
BEGIN
    CREATE TABLE app_user_permission (
        id_user    INT         NOT NULL,       -- utilisateur.id (GMAO_NGES)
        feature    VARCHAR(60) NOT NULL,       -- key from backend/src/features.js
        allowed    BIT         NOT NULL,       -- 1 = granted, 0 = removed
        updated_by INT         NULL,
        updated_at DATETIME    NOT NULL DEFAULT GETDATE(),
        CONSTRAINT PK_app_user_permission PRIMARY KEY (id_user, feature)
    );
END;
GO
