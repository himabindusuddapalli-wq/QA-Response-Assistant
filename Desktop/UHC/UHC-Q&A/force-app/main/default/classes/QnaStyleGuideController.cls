/**
 * @description Returns active Style Guide guidelines as plain text, for use as
 *              an Apex resource in the QA Style prompt template. Object-agnostic
 *              (no record input) so it resolves in a text-input Flex template.
 */
public with sharing class QnaStyleGuideController {

    @InvocableMethod(label='Get QA Style Guide')
    public static List<Response> getPrompt(List<Request> requests) {
        List<Proposal_Style_Guide__c> records = [
            SELECT Subsection_Title__c, Guideline__c
            FROM Proposal_Style_Guide__c
            WHERE IsActive__c = true AND Type__c = 'Style Guide'
        ];

        String promptText = 'Below are the style guidelines:\n\n';
        for (Proposal_Style_Guide__c rec : records) {
            promptText += '- **' + rec.Subsection_Title__c + '**: \n' + rec.Guideline__c + '\n\n';
        }

        Response output = new Response();
        output.Prompt = promptText.trim();
        return new List<Response>{ output };
    }

    public class Request {
        @InvocableVariable
        public String placeholder;   // not required, not used — just lets the resource bind
    }

    public class Response {
        @InvocableVariable
        public String Prompt;
    }
}