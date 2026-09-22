Deciding what to do when you hit those walls is the task.

Choosing which parts to handle properly is the rest of it.


1 Ingestion layer 3 sources: storefront orders, email events, and ad spend

2 client has 1 brand, is launching a 2nd one (havent finished yet)

3 the sources fail in the ordinary ways real sources fail:
 - a run dies halfway
 - the same file arrives twice
 - a column changes name without warning
 -  and yesterday's records turn up today.

4 We would rather see ingestion and replay done excellently and the rest sketched honestly than five areas half-built.

OBJECTIVE
Build a TypeScript service that ingests all four sources for both tenants into Postgres,

models them into something queryable through an API a client could call, 

and survives the failures in the fixtures. 

The whole window is in scope, including a backfill of what already landed.

Replay. A run dies a third of the way through. Re-running it must not double-count. The fixtures contain an overlapping export, so this is not hypothetical.
Schema drift. One source renames a column partway through the fixture set. Decide what the pipeline does: fail loudly, adapt, or quarantine. Any of the three can be right. Not noticing is not.
Late arrivals. Records for a day that was already processed arrive afterwards. Decide what happens to the numbers that were already reported.
The second tenant. Adding the third client must require configuration only. No new models, no branching on a client name. We will look for where tenant isolation is actually enforced, not where it is intended.


focus only on the service layer that ingess all four sources


WHAT THE CLIENT INSISTS ON
These came from the client and they are not negotiable, in their words:

Every number we report ties to their finance export to the cent. They reconcile against finance_summary.csv and a difference is treated as a bug.
A day we have reported is never restated. Their board sees weekly numbers and a number that moves after the fact costs them trust.


START TIME 9:58 AM

END TIME 17:58X`




OBTENEMOS EL SCHEMA DE CADA TABLA Y ESO ES LO QUE ESPERAMOS SIEMPRE

PRIMER PASO GUARDAMOS LOS RAW FILES EN STORAGE (S3_SANDBOX)
PASO DOS INTENTAMOS PROCESAR NORMALIZANDO LA DATA
PASO 3 INSERTAMOS LA DATA EN POSTGRE


USAREMOS, LOCAL STORAGE, TS, POSFRESQL CON PRISMA, EXPRESS SERVER TO GET THE FILES

CAMBIOS RAROS
LUMEN, CAMBIO DE NOMBRE DE AD SPEND
FALTA BATCH 3
