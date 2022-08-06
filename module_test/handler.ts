import _ from 'lodash';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';

const handler = (event: APIGatewayProxyEvent, context: Context) => {
  console.log('Event: %j', event);
  console.log('Event: %j', context);

  console.log(`Using lodash: ${_.range(10)}`);
};

export default handler;
