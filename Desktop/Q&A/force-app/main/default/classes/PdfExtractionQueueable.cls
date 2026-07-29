/**
 * Async PDF extraction job — makes the Document AI callout in its own
 * transaction so the upload never hits the 120-second HTTP timeout.
 * Retries up to MAX_RETRIES times on CalloutException before marking
 * the document as Extraction Failed.
 * Also kicks off answer-matching batch after successful extraction so
 * the LWC does not need to stay open.
 */
public class PdfExtractionQueueable implements Queueable, Database.AllowsCallouts {

    @TestVisible private static final Integer MAX_RETRIES = 2;

    private final Id      documentId;
    private final Id      contentVersionId;
    private final Integer retryCount;
    private final Id      uploadedByUserId;

    public PdfExtractionQueueable(Id documentId, Id contentVersionId, Integer retryCount, Id uploadedByUserId) {
        this.documentId       = documentId;
        this.contentVersionId = contentVersionId;
        this.retryCount       = retryCount;
        this.uploadedByUserId = uploadedByUserId;
    }

    public void execute(QueueableContext ctx) {
        try {
            // SOQL query is fine before the callout
            ContentVersion cv = [SELECT VersionData FROM ContentVersion WHERE Id = :contentVersionId LIMIT 1];
            String base64Data = EncodingUtil.base64Encode(cv.VersionData);

            // Document AI callout
            List<Map<String, Object>> rows = QaDocUploadController.extractQuestionsFromPdf(base64Data);

            // Build and insert question records
            List<Q_A_Question__c> questions = QaDocUploadController.buildQuestionsFromRows(documentId, rows);
            if (!questions.isEmpty()) {
                insert questions;
            }

            Integer questionCount = questions.size();

            if (questionCount > 0) {
                // Mark extraction done then immediately kick off answer matching
                update new Q_A_Document__c(
                    Id                     = documentId,
                    Total_Questions__c     = questionCount,
                    Finalized_Questions__c = 0,
                    Pending_Questions__c   = questionCount,
                    Status__c              = 'Digitization In-Progress'
                );
                Database.executeBatch(
                    new QnaAnswerSearchBatchProcessor(documentId, uploadedByUserId),
                    1
                );
            } else {
                update new Q_A_Document__c(
                    Id        = documentId,
                    Status__c = 'Digitization Successful'
                );
            }

        } catch (System.CalloutException ce) {
            if (retryCount < MAX_RETRIES) {
                System.enqueueJob(new PdfExtractionQueueable(documentId, contentVersionId, retryCount + 1, uploadedByUserId));
            } else {
                safeSetFailed(documentId);
            }
        } catch (Exception e) {
            System.debug('PdfExtractionQueueable failed: ' + e.getMessage() + '\n' + e.getStackTraceString());
            safeSetFailed(documentId);
        }
    }

    private static void safeSetFailed(Id docId) {
        try {
            update new Q_A_Document__c(Id = docId, Status__c = 'Extraction Failed');
        } catch (Exception e) {
            System.debug('safeSetFailed could not update document: ' + e.getMessage());
        }
    }
}