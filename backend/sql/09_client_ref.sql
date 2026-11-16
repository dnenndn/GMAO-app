-- Offline queue: the phone gives every BSM / DI it creates a unique reference so that
-- sending the same request twice (lost answer, retry) never creates it twice.
-- Run once in the GMAO_APP database.
USE GMAO_APP;
GO
IF OBJECT_ID('dbo.app_client_ref') IS NULL
CREATE TABLE dbo.app_client_ref (
  ref        varchar(64) NOT NULL PRIMARY KEY,
  id_user    int NULL,
  created_at datetime NOT NULL DEFAULT GETDATE()
);
GO
