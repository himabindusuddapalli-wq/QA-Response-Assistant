public with sharing class QnaReviewController {

    public class QuestionWrapper {
        @AuraEnabled public Id id;
        @AuraEnabled public String questionText;
        @AuraEnabled public Decimal questionNumber;
        @AuraEnabled public String section;
        @AuraEnabled public String status;
        @AuraEnabled public String finalAnswer; 
        @AuraEnabled public Boolean strategyApplied;
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getReviewData(Id documentId) {
        Map<String, Object> result = new Map<String, Object>();

        Q_A_Document__c doc = [
            SELECT Id, Name, Membership_Activity__c, Membership_Activity__r.Name
            FROM Q_A_Document__c
            WHERE Id = :documentId
            LIMIT 1
        ];
        result.put('documentName', doc.Name);
        result.put('membershipActivityName', doc.Membership_Activity__r.Name);

        List<QuestionWrapper> questions = new List<QuestionWrapper>();
        for (Q_A_Question__c q : [
            SELECT Id, QAQuestion__c, QAQuestionNo__c, Section__c, Status__c,Final_Answer__c,Strategy_Applied__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
            ORDER BY QAQuestionNo__c ASC NULLS LAST, Section__c ASC NULLS LAST
        ]) {
            QuestionWrapper w = new QuestionWrapper();
            w.id = q.Id;
            w.questionText = q.QAQuestion__c;
            w.questionNumber = q.QAQuestionNo__c;
            w.section = q.Section__c;
            w.status = q.Status__c;
            w.finalAnswer = q.Final_Answer__c;
            w.strategyApplied = q.Strategy_Applied__c;
            questions.add(w);
        }
        result.put('questions', questions);
        return result;
    }
    @AuraEnabled
    public static void saveAnswer(Id questionId, String answer, String status) {
        try {
            update new Q_A_Question__c(
                Id              = questionId,
                Final_Answer__c = answer,
                Status__c       = status,
                Is_Finalized__c = (status == 'Completed')
            );
            recalculateDocumentCounts(questionId);
        } catch (Exception e) {
            throw new AuraHandledException('Failed to save answer: ' + e.getMessage());
        }
    }

    // Recalculates Finalized/Pending question counts on the parent Q_A_Document__c
    // after a question's status changes, and advances the document status from
    // "Digitization Successful" to "Review In-Progress" on the first answer save.
    private static void recalculateDocumentCounts(Id questionId) {
        Q_A_Question__c q = [
            SELECT Q_A_Document__c, Q_A_Document__r.Status__c
            FROM Q_A_Question__c
            WHERE Id = :questionId
            LIMIT 1
        ];
        if (q.Q_A_Document__c == null) return;

        Integer total     = 0;
        Integer finalized  = 0;
        for (AggregateResult ar : [
            SELECT Status__c status, COUNT(Id) cnt
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :q.Q_A_Document__c
            GROUP BY Status__c
        ]) {
            Integer cnt = (Integer) ar.get('cnt');
            total += cnt;
            if ((String) ar.get('status') == 'Completed') finalized += cnt;
        }

        String currentStatus = q.Q_A_Document__r.Status__c;
        String newStatus = (currentStatus == 'Digitization Successful')
            ? 'Review In-Progress'
            : currentStatus;

        update new Q_A_Document__c(
            Id                     = q.Q_A_Document__c,
            Status__c              = newStatus,
            Finalized_Questions__c = finalized,
            Pending_Questions__c   = total - finalized
        );
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, List<String>> getRepositoryFilterOptions() {
        Map<String, Set<String>> seen = new Map<String, Set<String>>{
            'company'        => new Set<String>(),
            'consultingFirm' => new Set<String>(),
            'fileName'       => new Set<String>(),
            'industry'       => new Set<String>(),
            'rfpName'        => new Set<String>(),
            'svpName'        => new Set<String>(),
            'topicArea'      => new Set<String>()
        };

        for (Q_A_Document_Repository__c r : [
            SELECT Company__c, ConsultingFirm__c, FileName__c,
                   Industry__c, RFPName__c, SVPName__c, TopicArea__c
            FROM Q_A_Document_Repository__c
            LIMIT 5000
        ]) {
            if (String.isNotBlank(r.Company__c))        seen.get('company').add(r.Company__c.trim());
            if (String.isNotBlank(r.ConsultingFirm__c)) seen.get('consultingFirm').add(r.ConsultingFirm__c.trim());
            if (String.isNotBlank(r.FileName__c))       seen.get('fileName').add(r.FileName__c.trim());
            if (String.isNotBlank(r.Industry__c))       seen.get('industry').add(r.Industry__c.trim());
            if (String.isNotBlank(r.RFPName__c))        seen.get('rfpName').add(r.RFPName__c.trim());
            if (String.isNotBlank(r.SVPName__c))        seen.get('svpName').add(r.SVPName__c.trim());
            if (String.isNotBlank(r.TopicArea__c))      seen.get('topicArea').add(r.TopicArea__c.trim());
        }

        Map<String, List<String>> result = new Map<String, List<String>>();
        for (String key : seen.keySet()) {
            List<String> vals = new List<String>(seen.get(key));
            vals.sort();
            result.put(key, vals);
        }
        return result;
    }
        
    @AuraEnabled
    public static void markSelectedAnswer(Id questionId, Id answerId) {
        if (questionId == null || answerId == null) return;
        try {
            List<Q_A_Answer__c> toUpdate = new List<Q_A_Answer__c>();
            for (Q_A_Answer__c a : [
                SELECT Id, Is_Selected_Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
            ]) {
                Boolean shouldSelect = (a.Id == answerId);
                if (a.Is_Selected_Answer__c != shouldSelect) {
                    a.Is_Selected_Answer__c = shouldSelect;
                    toUpdate.add(a);
                }
            }
            if (!toUpdate.isEmpty()) update toUpdate;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to mark selected answer: ' + e.getMessage());
        }
    }

}