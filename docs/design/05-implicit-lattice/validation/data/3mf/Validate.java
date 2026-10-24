import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;

/**
 * Validates args[1..] against the schema directory args[0]. The root schema is implicit.xsd, or the file named by -Dschema=... (e.g. beamlattice.xsd);
 * every .xsd of the directory is copied to a work directory with maxOccurs="2147483647" rewritten to "unbounded" (same meaning; Xerces would expand the count).
 */
public class Validate {
  public static void main(String[] args) throws Exception {
    Path work = Files.createTempDirectory("xsd3mf");
    try (var files = Files.list(Path.of(args[0]))) {
      for (Path file : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".xsd"))::iterator) {
        String text = Files.readString(file);
        Files.writeString(work.resolve(file.getFileName().toString()), text.replace("maxOccurs=\"2147483647\"", "maxOccurs=\"unbounded\"").replace("maxOccurs=\"1073741824\"", "maxOccurs=\"unbounded\""));
      }
    }
    SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
    Schema schema = factory.newSchema(work.resolve(System.getProperty("schema", "implicit.xsd")).toFile());
    int failures = 0;
    for (int i = 1; i < args.length; i++) {
      try {
        Validator validator = schema.newValidator();
        validator.validate(new StreamSource(new File(args[i])));
        System.out.println("VALID " + args[i]);
      } catch (Exception error) {
        failures++;
        System.out.println("INVALID " + args[i] + (error instanceof org.xml.sax.SAXParseException p ? " line " + p.getLineNumber() : "") + ": " + error.getMessage());
      }
    }
    System.exit(failures == 0 ? 0 : 1);
  }
}
