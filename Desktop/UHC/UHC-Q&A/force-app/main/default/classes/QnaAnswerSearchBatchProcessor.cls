/**
 * @description       : Batch that fetches top-3 Data Cloud answers for every Q_A_Question__c
 *                      in a document, stores them as Q_A_Answer__c records, updates the document
 *                      status to "Digitization Successful", and emails the uploader when done.
 *                      Any per-question failure is written to Q_A_Audit_Log__c; if any questions
 *                      failed a summary email is sent at finish().
 * @author            : Ambika
 * @last modified on  : 07-29-2026
 *
 * Invocation (batch size MUST be 1 — one HTTP callout per question per transaction):
 *   Database.executeBatch(new QnaAnswerSearchBatchProcessor(docId, UserInfo.getUserId()), 1);
**/
public with sharing class QnaAnswerSearchBatchProcessor
        implements Database.Batchable<SObject>, Database.AllowsCallouts {

    private final Id   documentId;
    private final Id   submittedByUserId;
    private String     preferredConsultingFirm;

    // Tracks question IDs that failed so finish() can send one summary email.
    private List<Id>   failedQuestionIds = new List<Id>();

    public QnaAnswerSearchBatchProcessor(Id documentId, Id submittedByUserId) {
        this.documentId        = documentId;
        this.submittedByUserId = submittedByUserId;
    }

    // ── Batchable interface ──────────────────────────────────────────────────

    public Database.QueryLocator start(Database.BatchableContext bc) {
        safeUpdateDocStatus('Digitization In-Progress');

        return Database.getQueryLocator([
            SELECT Id, QAQuestion__c
            FROM   Q_A_Question__c
            WHERE  Q_A_Document__c = :documentId
            WITH   USER_MODE
            ORDER BY Id ASC
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Q_A_Question__c> scope) {
        // Scope size = 1 (enforced at invocation). One callout per transaction.
        for (Q_A_Question__c q : scope) {
            try {
                QnaAnswerSearchController.fetchAndStoreAnswers(q.Id, q.QAQuestion__c, preferredConsultingFirm);
            } catch (Exception e) {
                System.debug('QnaAnswerSearchBatchProcessor: question ' + q.Id + ' failed — ' + e.getMessage());
                failedQuestionIds.add(q.Id);
                QnAAuditLogService.logFailure(
                    documentId,
                    q.Id,
                    'Answer Processing Failed',
                    e.getMessage(),
                    e.getStackTraceString(),
                    'QnaAnswerSearchBatchProcessor'
                );
            }
        }
    }
public void finish(Database.BatchableContext bc) {
        safeUpdateDocStatus('Digitization Successful');

        // Stamp how many questions ended up with at least one relevant match.
        try {
            QaDocUploadController.updateMatchesFoundCount(documentId);
        } catch (Exception e) {
            System.debug('QnaAnswerSearchBatchProcessor: matches-found count failed — ' + e.getMessage());
        }

        Integer questionCount = [
            SELECT COUNT() FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
            WITH USER_MODE
        ];
        QaDocUploadController.sendDigitizationEmail(documentId, questionCount);

        if (!failedQuestionIds.isEmpty()) {
            String summary = failedQuestionIds.size() + ' question(s) failed during answer matching. '
                + 'Audit logs have been created for each. '
                + 'The remaining questions were processed successfully.';
            QnAAuditLogService.sendFailureEmail(
                documentId,
                'Answer Processing Failed',
                summary,
                submittedByUserId
            );
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private void safeUpdateDocStatus(String status) {
        try {
            update new Q_A_Document__c(Id = documentId, Status__c = status);
        } catch (Exception e) {
            System.debug('QnaAnswerSearchBatchProcessor: status update failed — ' + e.getMessage());
        }
    }

}